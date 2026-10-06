// 团体赛名单与团体榜单。
//
// 名单（整体替换，携带 expectedRevision）：
//   teams: [{ code（队伍代码，唯一非空）, name（队伍名称，非空）, bibs: 号码布名单（至少 3 人） }]
//   - 每名选手只能属一队：号码布跨队重复整次拒绝；
//   - 非法号码布（空/非字符串）整次拒绝；
//   - 号码布可尚未导入打卡（先入队：自动登记 runner，等待读数，状态无出发）；
//   - 提交内容与现有完全一致为只读，不推进修订。
//
// 团体成绩（实时重算；打卡/罚时/停表/赛道/申诉确认后调用方自然拿到新结果）：
//   取本队「正式完赛选手」中 officialElapsed 最短的三人合计；不足三人 => 未成队、不排名；
//   合计相同并列同名次；榜单列出计分三人与各自正式耗时。
import { loadConfig, computeResults } from './scoring.mjs';

/** 读取当前团体名单：[{ code, name, bibs }]，按队伍 seq、成员 seq 排序 */
export function loadTeams(db) {
  const teams = db.prepare('SELECT id, code, name, seq FROM team ORDER BY seq').all();
  const getMembers = db.prepare('SELECT bib FROM team_member WHERE team_id = ? ORDER BY seq');
  return teams.map((t) => ({
    code: t.code,
    name: t.name,
    bibs: getMembers.all(t.id).map((m) => m.bib),
  }));
}

/**
 * 规范化并整次校验团体名单。任一非法返回 { error }（整次拒绝，不部分写入）。
 * 规则：teams 须为数组（空数组 = 清除全部队伍）；队码非空且全表唯一；队名非空；
 * 每队至少三名成员；号码布非空、同队不重复、跨队不重复。
 */
export function validateTeams(rawTeams) {
  if (!Array.isArray(rawTeams))
    return { error: 'teams 须为数组（可空，空数组表示清除全部团体名单）' };
  const teams = [];
  const codes = new Set();
  const globalBibs = new Set();
  for (let i = 0; i < rawTeams.length; i++) {
    const t = rawTeams[i];
    const where = `第 ${i + 1} 支队伍`;
    if (!t || typeof t !== 'object') return { error: `${where} 格式非法，整次拒绝` };
    const code = typeof t.code === 'string' ? t.code.trim() : '';
    if (!code) return { error: `${where}：队伍代码必填，整次拒绝` };
    if (codes.has(code)) return { error: `队伍代码「${code}」重复，整次拒绝` };
    const name = typeof t.name === 'string' ? t.name.trim() : '';
    if (!name) return { error: `队伍「${code}」名称必填，整次拒绝` };
    if (!Array.isArray(t.bibs)) return { error: `队伍「${code}」号码布名单须为数组，整次拒绝` };
    const bibs = [];
    const inTeam = new Set();
    for (const rawBib of t.bibs) {
      const bib = typeof rawBib === 'string' ? rawBib.trim() : '';
      if (!bib) return { error: `队伍「${code}」存在非法号码布，整次拒绝` };
      if (inTeam.has(bib))
        return { error: `号码布 ${bib} 在队伍「${code}」内重复，整次拒绝` };
      if (globalBibs.has(bib))
        return { error: `号码布 ${bib} 跨队重复（每名选手只能属一队），整次拒绝` };
      inTeam.add(bib);
      globalBibs.add(bib);
      bibs.push(bib);
    }
    if (bibs.length < 3)
      return { error: `队伍「${code}」至少登记三名成员（当前 ${bibs.length} 人），整次拒绝` };
    codes.add(code);
    teams.push({ code, name, bibs });
  }
  return { teams };
}

/** 与库中现有名单比较：队伍（代码/名称/成员顺序无关，按集合比较）完全一致时为只读 */
export function teamsEqual(current, next) {
  const norm = (list) =>
    list
      .map((t) => `${t.code}${t.name}${[...t.bibs].sort().join('')}`)
      .sort()
      .join('');
  return norm(current) === norm(next);
}

/** 名单对外形态（GET /api/teams）：附带修订号 */
export function listTeams(db, revision) {
  return { revision, teams: loadTeams(db) };
}

/**
 * 整体替换团体名单（调用方已完成 expectedRevision 与整次校验）。
 * 未导入打卡的号码布自动登记 runner（先入队，等待读数）。
 * 返回 { revision, changed }；内容完全一致时不写库、不推进修订。
 */
export function replaceTeams(db, teams) {
  const current = loadTeams(db);
  if (teamsEqual(current, teams))
    return { revision: currentRev(db), changed: false };
  const revision = db.transaction(() => {
    // 整体替换：删除旧队伍（成员随外键级联清除）后重建
    db.prepare('DELETE FROM team_member').run();
    db.prepare('DELETE FROM team').run();
    const insRunner = db.prepare('INSERT INTO runner (bib, name) VALUES (?, NULL) ON CONFLICT(bib) DO NOTHING');
    const insTeam = db.prepare('INSERT INTO team (code, name, seq) VALUES (?, ?, ?)');
    const insMember = db.prepare('INSERT INTO team_member (team_id, bib, seq) VALUES (?, ?, ?)');
    teams.forEach((t, i) => {
      const tid = insTeam.run(t.code, t.name, i + 1).lastInsertRowid;
      t.bibs.forEach((bib, j) => {
        insRunner.run(bib); // 尚未导入打卡的号码布也可先入队
        insMember.run(tid, bib, j + 1);
      });
    });
    return bumpRev(db);
  })();
  return { revision, changed: true };
}

/**
 * 计算团体榜单。
 * results 为 computeResults 输出（已含每人 officialElapsed/rank/divisionCode 等）。
 * 每队取正式完赛选手中 officialElapsed 最短的三人合计：
 *  - 不足三人 => complete=false、rank=null（未成队，不排名）；
 *  - 合计相同 => 并列同名次（rank 按前序队伍数 +1 的标准并列算法）；
 *  - 榜单按 1) 是否成队 2) 合计升序 3) 队码 排序，并列同 rank。
 * members 为队伍全部成员（含未成队/未完赛者），scorers 为计分三人与各自耗时。
 */
export function computeTeamStandings(teams, results) {
  const byBib = new Map(results.map((r) => [r.bib, r]));
  const standings = teams.map((t) => {
    const members = t.bibs.map((bib) => {
      const r = byBib.get(bib);
      return {
        bib,
        name: r?.name ?? null,
        status: r?.status ?? 'no_start',
        officialElapsed: r?.officialElapsed ?? null,
        inResults: !!r,
      };
    });
    // 正式完赛者（有 officialElapsed）按正式耗时升序，取最短三人
    const finishers = members
      .filter((m) => m.officialElapsed != null)
      .sort((a, b) =>
        a.officialElapsed !== b.officialElapsed
          ? a.officialElapsed - b.officialElapsed
          : a.bib.localeCompare(b.bib)
      );
    const scorers = finishers.slice(0, 3);
    const complete = scorers.length === 3;
    const total = complete ? scorers.reduce((n, m) => n + m.officialElapsed, 0) : null;
    return {
      code: t.code,
      name: t.name,
      complete,
      totalOfficialElapsed: total, // 计分三人 officialElapsed 合计；未成队为 null
      rank: null, // 下方统一排名
      scorerCount: scorers.length,
      scorers: scorers.map((m) => ({ bib: m.bib, name: m.name, officialElapsed: m.officialElapsed })),
      members,
    };
  });

  // 成队者按合计排名（允许并列）；未成队者不参与、rank 保持 null
  standings.sort((a, b) => {
    if (a.complete !== b.complete) return a.complete ? -1 : 1;
    if (!a.complete) return a.code.localeCompare(b.code);
    if (a.totalOfficialElapsed !== b.totalOfficialElapsed)
      return a.totalOfficialElapsed - b.totalOfficialElapsed;
    return a.code.localeCompare(b.code);
  });
  let rank = 0;
  let prevTotal = null;
  standings.forEach((s, i) => {
    if (s.complete) {
      if (s.totalOfficialElapsed !== prevTotal) rank = i + 1;
      s.rank = rank;
      prevTotal = s.totalOfficialElapsed;
    }
  });
  return standings;
}

/** 团体榜单对外精简形态（与发布快照一致） */
export function teamStandingsView(standings) {
  return standings.map((s) => ({
    code: s.code,
    name: s.name,
    complete: s.complete,
    rank: s.rank,
    totalOfficialElapsed: s.totalOfficialElapsed,
    scorerCount: s.scorerCount,
    scorers: s.scorers,
    members: s.members.map((m) => ({
      bib: m.bib, name: m.name, status: m.status, officialElapsed: m.officialElapsed,
    })),
  }));
}

/** 便捷：读取名单 + 已加载配置核算团体榜单（实时） */
export function liveTeamStandings(db, cfg = loadConfig(db)) {
  const teams = loadTeams(db);
  const results = computeResults(db, cfg);
  return teamStandingsView(computeTeamStandings(teams, results));
}

// 事务内直接使用的修订号助手（与 penalties.mjs 相同写法，避免与 db.mjs 形成导入环）
function currentRev(db) {
  const row = db.prepare('SELECT revision FROM event WHERE id = 1').get();
  return row ? row.revision : 0;
}
function bumpRev(db) {
  return db.prepare('UPDATE event SET revision = revision + 1 WHERE id = 1 RETURNING revision').get().revision;
}
