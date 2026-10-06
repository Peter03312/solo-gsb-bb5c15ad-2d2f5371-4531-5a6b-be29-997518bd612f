import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { fmtTime } from './Results.jsx';

const EMPTY_TEAM = () => ({ code: '', name: '', bibsText: '' });
const toDraft = teams => teams.map(t => ({ code: t.code, name: t.name, bibsText: t.bibs.join(', ') }));

/**
 * 团体赛：名单维护（队伍代码/名称/号码布，整体替换）+ 实时团体榜单。
 * - 每名选手只能属一队（跨队重复号码布整次拒绝）；每队至少三人；号码布可尚未导入打卡（先入队）；
 * - 保存携带 expectedRevision；等价提交不推进修订；过期返回当前修订号；
 * - 团体成绩 = 本队正式完赛选手中 officialElapsed 最短三人合计；不足三人未成队不排名；合计相同并列；
 * - 榜单随打卡/罚时/停表/赛道/申诉确认实时重算（5s 轮询）。
 */
export default function Teams({ event, onChanged, onError }) {
  const [draft, setDraft] = useState([]);
  const [standings, setStandings] = useState(null);
  const [runners, setRunners] = useState([]);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  // 草稿仅在首次加载与保存成功后与服务器同步；用户编辑期间轮询不覆盖草稿。
  const syncDraft = useRef(true);

  const load = useCallback(async () => {
    try {
      const [tv, rs] = await Promise.all([api.teams(), api.results()]);
      setStandings(tv);
      setRunners((rs.results || []).map(r => ({ bib: r.bib, name: r.name })));
      if (syncDraft.current) {
        setDraft(toDraft(tv.teams || []));
        syncDraft.current = false;
      }
    } catch {
      setStandings(null);
    }
  }, []);

  useEffect(() => {
    if (event?.configured) load();
  }, [event, load]);
  useEffect(() => {
    if (!event?.configured) return undefined;
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [event, load]);

  const setTeam = (i, patch) => setDraft(ts => ts.map((t, j) => (j === i ? { ...t, ...patch } : t)));

  // 解析每队号码布（逗号/空白/换行分隔）
  const parsed = useMemo(
    () =>
      draft.map(t => ({
        code: t.code.trim(),
        name: t.name.trim(),
        bibs: t.bibsText.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean),
      })),
    [draft]
  );

  // 客户端即时校验（与后端 400 文案一致，后端仍整次校验兜底）
  const errors = useMemo(() => {
    const errs = [];
    const codes = new Set();
    const globalBibs = new Set();
    parsed.forEach((t, i) => {
      const where = `第 ${i + 1} 支队伍`;
      if (!t.code) return errs.push(`${where}：队伍代码必填`);
      if (codes.has(t.code)) return errs.push(`队伍代码「${t.code}」重复`);
      if (!t.name) errs.push(`队伍「${t.code}」名称必填`);
      const inTeam = new Set();
      for (const bib of t.bibs) {
        if (inTeam.has(bib)) errs.push(`号码布 ${bib} 在队伍「${t.code}」内重复`);
        if (globalBibs.has(bib)) errs.push(`号码布 ${bib} 跨队重复（每名选手只能属一队）`);
        inTeam.add(bib);
        globalBibs.add(bib);
      }
      if (t.bibs.length < 3) errs.push(`队伍「${t.code}」至少登记三名成员（当前 ${t.bibs.length} 人）`);
      codes.add(t.code);
    });
    return errs;
  }, [parsed]);

  const submit = async () => {
    if (!event?.configured) return onError(new Error('请先配置赛事'));
    if (errors.length) return onError(new Error(`${errors[0]}，整次拒绝`));
    setBusy(true);
    try {
      const r = await api.saveTeams({
        expectedRevision: event.revision,
        teams: parsed.map(t => ({ code: t.code, name: t.name, bibs: t.bibs })),
      });
      setSaved(r.changed ? '已保存（团体名单已整体替换）' : '内容无变化，修订号未推进');
      syncDraft.current = true;
      await onChanged();
      await load();
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      if (err.status === 409) syncDraft.current = true; // 他人已改动：下次拉取刷新草稿
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const appendBib = (i, bib) => {
    const t = draft[i];
    const cur = t.bibsText.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
    if (!cur.includes(bib)) setTeam(i, { bibsText: [...cur, bib].join(', ') });
  };

  if (!event?.configured) return <p className="muted">请先配置赛事。</p>;

  const teamRows = standings?.teamResults || [];

  return (
    <div className="panel">
      <h2>团体赛名单与团体榜单</h2>
      <p className="muted small">
        赛事方按<b>队伍代码、名称及号码布名单</b>维护团体赛名单（整体替换）：<b>每名选手只能属一队</b>，
        每队<b>至少登记三人</b>，<b>未导入打卡的号码布可先入队</b>（自动登记，等待读数）。
        保存须携带修订号：重复队码、跨队重复号码布、成员不足三人或非法号码布<b>整次拒绝</b>；
        过期返回当前修订号，等价提交不推进修订。团体成绩取本队<b>正式完赛选手中耗时最短的三人</b>合计
        <b> officialElapsed</b>；不足三人显示<b>未成队且不排名</b>，合计相同<b>并列</b>，榜单列出计分三人与各自耗时。
        打卡、罚时、停表、赛道与整案申诉确认后榜单<b>实时重算</b>；发布版冻结名单与榜单，后续改动不影响旧版
        （旧发布版迁移后按无团体名单展示）。
      </p>

      <h3>实时团体榜单（修订 #{standings?.revision ?? '—'}）</h3>
      <table className="grid compact">
        <thead>
          <tr>
            <th style={{ width: 60 }}>名次</th><th style={{ width: 80 }}>队码</th><th>队名</th>
            <th>计分三人（号码布 · 姓名 · 正式耗时）</th><th style={{ width: 120 }}>合计 officialElapsed</th>
            <th style={{ width: 160 }}>成员状态</th>
          </tr>
        </thead>
        <tbody>
          {teamRows.map(t => (
            <tr key={t.code} className={t.complete ? '' : 'row-dnf'}>
              <td><b>{t.rank ?? '—'}</b>{!t.complete && <div className="muted small">未成队</div>}</td>
              <td>{t.code}</td>
              <td>{t.name}</td>
              <td>
                {t.complete ? (
                  <span className="chain">
                    {t.scorers.map((s, i) => (
                      <React.Fragment key={s.bib}>
                        {i > 0 && <span className="arrow">+</span>}
                        <span className="chip" title={s.name || ''}>
                          {s.bib}<small>{s.name || '待读数'}</small>
                          <b>{fmtTime(s.officialElapsed)}（{s.officialElapsed}s）</b>
                        </span>
                      </React.Fragment>
                    ))}
                  </span>
                ) : (
                  <span className="muted small">
                    正式完赛仅 {t.scorerCount} 人（至少需 3 人），未成队、不排名
                  </span>
                )}
              </td>
              <td>
                {t.complete
                  ? <b>{fmtTime(t.totalOfficialElapsed)}（{t.totalOfficialElapsed}s）</b>
                  : <span className="muted">—</span>}
              </td>
              <td className="small">
                {t.members.map(m => (
                  <span key={m.bib} className={`chip ${m.officialElapsed == null ? 'row-dnf' : ''}`}
                    style={{ margin: 2 }}
                    title={m.status}>
                    {m.bib}<small>{m.officialElapsed != null ? `${m.officialElapsed}s` : m.status}</small>
                  </span>
                ))}
              </td>
            </tr>
          ))}
          {teamRows.length === 0 && (
            <tr><td colSpan="6" className="muted">暂无团体名单。在下方维护后保存即可生成榜单。</td></tr>
          )}
        </tbody>
      </table>

      <h3>团体名单维护（{draft.length} 支队伍 · 整体替换）</h3>
      {draft.map((t, i) => {
        const used = new Set(parsed[i].bibs);
        const available = runners.filter(r => !used.has(r.bib));
        return (
          <fieldset key={i} className="group-box">
            <legend>队伍 {i + 1}</legend>
            <div className="form-row three">
              <label>队伍代码<input value={t.code} onChange={e => setTeam(i, { code: e.target.value })} placeholder="如：RED" /></label>
              <label>队伍名称<input value={t.name} onChange={e => setTeam(i, { name: e.target.value })} placeholder="如：红山队" /></label>
              <label>成员数<div style={{ alignSelf: 'center', fontWeight: 600 }}>{parsed[i].bibs.length} 人（至少 3 人）</div></label>
            </div>
            <label className="small muted">号码布名单（逗号/空格/换行分隔；可含尚未导入打卡的号码布）</label>
            <textarea rows={2} className="code-input" value={t.bibsText}
              onChange={e => setTeam(i, { bibsText: e.target.value })}
              placeholder="001, 004, 006, 301" />
            {available.length > 0 && (
              <div className="small" style={{ marginTop: 6 }}>
                <span className="muted">追加已有号码布：</span>
                {available.slice(0, 12).map(r => (
                  <button type="button" key={r.bib} className="btn small" style={{ padding: '2px 8px', margin: 2 }}
                    onClick={() => appendBib(i, r.bib)}>
                    {r.bib}{r.name ? ` ${r.name}` : ''}
                  </button>
                ))}
                {available.length > 12 && <span className="muted"> …</span>}
              </div>
            )}
          </fieldset>
        );
      })}
      {draft.length === 0 && <p className="muted small">暂无队伍草稿。保存空名单可清除全部团体队伍。</p>}
      <button type="button" className="btn" onClick={() => setDraft(ts => [...ts, EMPTY_TEAM()])}>+ 添加队伍</button>
      {draft.length > 0 && (
        <button type="button" className="btn danger" onClick={() => setDraft(ts => ts.slice(0, -1))}>删除末队</button>
      )}

      {errors.length > 0 && (
        <ul className="rules" style={{ color: '#c62828' }}>
          {errors.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}

      <div className="actions">
        <button className="btn primary" disabled={busy} onClick={submit}>
          整体替换保存名单（基于修订 #{event?.revision ?? '—'}）
        </button>
        {saved && <span className="ok-text">{saved}</span>}
      </div>
    </div>
  );
}
