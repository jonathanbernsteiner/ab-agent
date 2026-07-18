-- Third configurable overdue window: business days of further silence after
-- the level-2 reminder before the PO escalates internally (level 3). Was
-- previously hardcoded to reuse level2_days.
alter table companies add column if not exists escalation_days int not null default 3;
