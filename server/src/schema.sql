-- 定向越野打卡争议复核系统 schema
-- 赛事单例 + 修订号（乐观锁）
CREATE TABLE IF NOT EXISTS event (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  name            TEXT NOT NULL,
  start_point     TEXT NOT NULL,
  finish_point    TEXT NOT NULL,
  finish_cutoff   INTEGER NOT NULL CHECK (finish_cutoff >= 0),
  revision        INTEGER NOT NULL DEFAULT 1
);

-- 按顺序通过的关卡组（seq 决定先后）
CREATE TABLE IF NOT EXISTS checkpoint_group (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  seq         INTEGER NOT NULL,
  name        TEXT NOT NULL,
  cutoff_secs INTEGER CHECK (cutoff_secs IS NULL OR cutoff_secs >= 0)
);

-- 组内可替代点位（任选其一）
CREATE TABLE IF NOT EXISTS group_point (
  group_id INTEGER NOT NULL REFERENCES checkpoint_group(id) ON DELETE CASCADE,
  point    TEXT NOT NULL,
  seq      INTEGER NOT NULL,
  PRIMARY KEY (group_id, point)
);

-- 参赛组别（同场赛事可设不同组别赛道；未分组选手沿用上方默认赛道）
CREATE TABLE IF NOT EXISTS division (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  finish_cutoff INTEGER NOT NULL CHECK (finish_cutoff >= 0),
  seq           INTEGER NOT NULL
);

-- 组别赛道的有序关卡组（结构与默认赛道相同，按 seq 依次通过）
CREATE TABLE IF NOT EXISTS division_group (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  division_id INTEGER NOT NULL REFERENCES division(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  name        TEXT NOT NULL,
  cutoff_secs INTEGER CHECK (cutoff_secs IS NULL OR cutoff_secs >= 0)
);

-- 组别关卡组内可替代点位（任选其一；空替代点位在保存时整次拒绝，不会落库）
CREATE TABLE IF NOT EXISTS division_group_point (
  group_id INTEGER NOT NULL REFERENCES division_group(id) ON DELETE CASCADE,
  point    TEXT NOT NULL,
  seq      INTEGER NOT NULL,
  PRIMARY KEY (group_id, point)
);

-- 选手归属：按号码布指定组别；一个号码布最多属于一个组别，未归属者走默认赛道
CREATE TABLE IF NOT EXISTS runner_division (
  bib         TEXT PRIMARY KEY REFERENCES runner(bib),
  division_id INTEGER NOT NULL REFERENCES division(id) ON DELETE CASCADE
);

-- 统一停表区间（天气等原因赛事统一停表；距发枪秒数，左闭右开，[start,end)）
-- 全赛事单例集合：整体替换维护；重叠区间在核算时按并集只计一次。
CREATE TABLE IF NOT EXISTS stoppage_interval (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  start_secs INTEGER NOT NULL CHECK (start_secs >= 0),
  end_secs   INTEGER NOT NULL CHECK (end_secs >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (start_secs < end_secs)
);

CREATE TABLE IF NOT EXISTS runner (
  bib  TEXT PRIMARY KEY,
  name TEXT
);

-- 团体赛队伍：赛事方按「队伍代码 + 名称 + 号码布名单」整体替换维护团体赛名单。
-- 每名选手只能属一队（team_member.bib 唯一索引保证）；队伍至少登记三人（保存时整次校验）；
-- 名单中的号码布可尚未导入打卡（先入队，自动登记选手，等待读数）。
CREATE TABLE IF NOT EXISTS team (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  seq  INTEGER NOT NULL
);

-- 团体赛名单成员：bib 全局唯一 => 一名选手只能属一队（跨队重复号码布整次拒绝）。
CREATE TABLE IF NOT EXISTS team_member (
  team_id INTEGER NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  bib     TEXT NOT NULL REFERENCES runner(bib),
  seq     INTEGER NOT NULL,
  PRIMARY KEY (team_id, bib)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_member_bib ON team_member(bib);

-- 打卡原始读数。record_no 全局唯一。
-- status: active（有效，含被更正后的现值）| voided（裁判作废，不参与核算）
-- point/seconds/bib/kind 为「现值」（裁判更正会改 point/seconds）；
-- orig_* 为首次入库时的原始读数，永不随更正/作废/重导改变，
-- 是批量重导判定「同号内容是否一致」的唯一依据。
CREATE TABLE IF NOT EXISTS punch (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  record_no  TEXT NOT NULL UNIQUE,
  bib        TEXT NOT NULL REFERENCES runner(bib),
  point      TEXT NOT NULL,
  seconds    INTEGER NOT NULL CHECK (seconds >= 0),
  kind       TEXT NOT NULL CHECK (kind IN ('start','enroute','finish')),
  orig_bib     TEXT NOT NULL,
  orig_point   TEXT NOT NULL,
  orig_seconds INTEGER NOT NULL CHECK (orig_seconds >= 0),
  orig_kind    TEXT NOT NULL CHECK (orig_kind IN ('start','enroute','finish')),
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','voided')),
  void_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_punch_bib ON punch(bib);

-- 裁判操作审计：作废 / 更正均保留原值与原因（更正只改 point/seconds）
CREATE TABLE IF NOT EXISTS punch_audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  punch_id     INTEGER NOT NULL REFERENCES punch(id),
  action       TEXT NOT NULL CHECK (action IN ('void', 'correct')),
  orig_point   TEXT,
  orig_seconds INTEGER,
  new_point    TEXT,
  new_seconds  INTEGER,
  reason       TEXT NOT NULL,
  at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 罚时裁决（裁判对选手加罚的秒数；officialElapsed = netElapsed + 有效罚时合计）
-- ruling_no 全局唯一；撤销后号码永久不可复用（登记被撤销号码整批拒绝）。
-- status: active（有效，计入正式耗时）| revoked（已撤销，不再计入；留痕保留）
CREATE TABLE IF NOT EXISTS penalty_ruling (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ruling_no     TEXT NOT NULL UNIQUE,
  bib           TEXT NOT NULL REFERENCES runner(bib),
  seconds       INTEGER NOT NULL CHECK (seconds > 0),
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  revoke_reason TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_penalty_bib ON penalty_ruling(bib);

-- 罚时裁决审计：登记 / 撤销均逐条留痕（整批成功时一次性写入；整批拒绝不写任何一条）
CREATE TABLE IF NOT EXISTS penalty_audit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ruling_no     TEXT NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('register','revoke')),
  bib           TEXT,
  seconds       INTEGER,
  reason        TEXT,
  revoke_reason TEXT,
  at            TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 发布快照（冻结，不可变）：同时冻结发布当时的停表区间、组别赛道/归属、罚时裁决与团体名单/榜单
CREATE TABLE IF NOT EXISTS publication (
  version         INTEGER PRIMARY KEY,
  event_revision  INTEGER NOT NULL,
  published_at    TEXT NOT NULL DEFAULT (datetime('now')),
  note            TEXT,
  config_json     TEXT NOT NULL,
  stoppages_json  TEXT NOT NULL DEFAULT '[]',
  divisions_json  TEXT NOT NULL DEFAULT '{"divisions":[],"assignments":[]}',
  penalties_json  TEXT NOT NULL DEFAULT '{"rulings":[],"audits":[]}',
  teams_json      TEXT NOT NULL DEFAULT '{"teams":[]}',
  team_results_json TEXT NOT NULL DEFAULT '[]',
  readings_json   TEXT NOT NULL,
  results_json    TEXT NOT NULL
);

-- 发布版成绩（便于排名查询），历史版永不被后续更正修改
-- elapsed=原始耗时；net_elapsed=发布当时按冻结停表区间算出的净耗时（未完赛为 NULL）
-- penalty_secs=冻结的有效罚时合计（未完赛为 0）；official_elapsed=net_elapsed+penalty_secs（未完赛为 NULL）
-- rank_no=全场正式耗时名次；group_rank=同组完赛者中的组内名次（允许并列，未完赛为 NULL）
CREATE TABLE IF NOT EXISTS published_result (
  publication_version INTEGER NOT NULL REFERENCES publication(version),
  bib         TEXT NOT NULL,
  name        TEXT,
  status      TEXT NOT NULL,
  elapsed     INTEGER,
  net_elapsed INTEGER,
  penalty_secs    INTEGER NOT NULL DEFAULT 0,
  official_elapsed INTEGER,
  fail_at     TEXT,
  detail      TEXT,
  rank_no     INTEGER,
  division_code TEXT,
  group_rank  INTEGER,
  PRIMARY KEY (publication_version, bib)
);

-- 发布版团体榜单（便于排名查询）：冻结发布当时的团体名单与正式完赛三人合计/并列名次。
-- 旧发布版迁移后按无团体名单处理：本表不回填，详情接口 teamResults 返回 []。
-- complete=1：至少三名正式完赛选手；rank_no 为团体名次（合计相同并列，未成队为 NULL）。
-- members_json 为当时队伍全部成员（号码布+姓名）；scorers_json 为计分三人 [{bib,name,officialElapsed}]。
CREATE TABLE IF NOT EXISTS published_team (
  publication_version INTEGER NOT NULL REFERENCES publication(version),
  team_code  TEXT NOT NULL,
  team_name  TEXT NOT NULL,
  complete   INTEGER NOT NULL,
  total_official_elapsed INTEGER,
  rank_no    INTEGER,
  members_json TEXT NOT NULL,
  scorers_json TEXT NOT NULL,
  PRIMARY KEY (publication_version, team_code)
);

-- 杂项键值（如 seed 标记）
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
