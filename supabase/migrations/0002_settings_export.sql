-- App settings (configurable deadlines) + export history.

create table if not exists app_settings (
  id            uuid primary key default gen_random_uuid(),
  overdue_days  int not null default 3,   -- silent window before overdue
  level2_days   int not null default 3,   -- further silence before level-2 chaser
  is_active     boolean not null default true,
  updated_at    timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

create table if not exists export_runs (
  id          uuid primary key default gen_random_uuid(),
  filename    text,
  row_count   int not null default 0,
  auto_count  int not null default 0,
  approved_count int not null default 0,
  created_at  timestamptz not null default now()
);

alter table app_settings enable row level security;
alter table export_runs  enable row level security;
