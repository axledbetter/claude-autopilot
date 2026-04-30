schema_version: 1
migrate:
  skill: "migrate.supabase@1"
  supabase:
    deltas_dir: "data/deltas"
    types_out: "types/supabase.ts"
    envs_file: ".claude/supabase-envs.json"
  envs:
    dev:
      command:
        exec: "node"
        args: ["mini-migrator.mjs"]
  policy:
    allow_prod_in_ci: false
    require_clean_git: false
    require_manual_approval: false
    require_dry_run_first: false
