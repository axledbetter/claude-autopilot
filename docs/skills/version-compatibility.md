# Skill version compatibility

`@delegance/claude-autopilot` uses a two-axis version system to ensure skills remain compatible across runtime upgrades.

## The two version axes

1. **Envelope contract version** (runtime declares) — the wire format of `InvocationEnvelope` and `ResultArtifact`. Currently `1.0`.
2. **Skill runtime API version** (skill manifest declares) — what envelope contract major the skill targets. Currently `1.0`.

## Compatibility rules

A skill is compatible with the current runtime when:
1. Skill `min_runtime` ≤ current runtime version ≤ skill `max_runtime` (strict semver, no pre-releases by default)
2. Skill `skill_runtime_api_version` major == runtime envelope contract major

Both must hold. Violation fails closed at handshake time with an upgrade message.

## Current matrix

| Runtime version | Envelope contract | Compatible skill API versions |
|---|---|---|
| 5.2.x | 1.0 | 1.x |
| 5.3.x (planned) | 1.0 | 1.x |
| 6.0.x (hypothetical) | 2.0 | 2.x (1.x skills sunset) |

## Skill manifest format

Every skill ships `skills/<name>/skill.manifest.json`:

```json
{
  "skillId": "migrate.supabase@1",
  "skill_runtime_api_version": "1.0",
  "min_runtime": "5.2.0",
  "max_runtime": "5.x",
  "stdoutFallback": false
}
```

Range syntax:
- Exact lower bound: `min_runtime: "5.2.0"` means `>= 5.2.0`
- Wildcard upper bound: `max_runtime: "5.x"` means `< 6.0.0`
- Pre-releases (`5.2.0-beta`) do NOT satisfy plain ranges (semver strictness)

## Bumping versions

- **Skill bug fix that doesn't change the contract:** no version change required
- **New optional manifest field:** bump `skill_runtime_api_version` minor (1.0 → 1.1)
- **Breaking envelope/result format change:** bump runtime major (5.x → 6.x), publish new envelope contract major
