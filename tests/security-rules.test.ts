import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-sec-')); }

// ── sql-injection ─────────────────────────────────────────────────────────────
describe('sql-injection', () => {
  it('flags template literal with SQL keyword', async () => {
    const { sqlInjectionRule } = await import('../src/core/static-rules/rules/sql-injection.ts');
    const dir = tmp();
    const file = path.join(dir, 'db.ts');
    fs.writeFileSync(file, 'const rows = db.query(`SELECT * FROM users WHERE id = ${userId}`);\n');
    const findings = await sqlInjectionRule.check([file]);
    assert.ok(findings.length > 0, 'expected sql-injection finding');
    assert.equal(findings[0]!.category, 'sql-injection');
    assert.equal(findings[0]!.severity, 'critical');
    fs.rmSync(dir, { recursive: true });
  });

  it('flags string concatenation with SQL', async () => {
    const { sqlInjectionRule } = await import('../src/core/static-rules/rules/sql-injection.ts');
    const dir = tmp();
    const file = path.join(dir, 'db.ts');
    fs.writeFileSync(file, 'const sql = "SELECT * FROM users WHERE name = \'" + name + "\'";\n');
    const findings = await sqlInjectionRule.check([file]);
    assert.ok(findings.length > 0);
    fs.rmSync(dir, { recursive: true });
  });

  it('passes parameterized queries', async () => {
    const { sqlInjectionRule } = await import('../src/core/static-rules/rules/sql-injection.ts');
    const dir = tmp();
    const file = path.join(dir, 'db.ts');
    fs.writeFileSync(file, 'const rows = db.query("SELECT * FROM users WHERE id = $1", [userId]);\n');
    const findings = await sqlInjectionRule.check([file]);
    assert.equal(findings.length, 0, `unexpected: ${findings[0]?.message}`);
    fs.rmSync(dir, { recursive: true });
  });

  it('skips test files', async () => {
    const { sqlInjectionRule } = await import('../src/core/static-rules/rules/sql-injection.ts');
    const dir = tmp();
    const file = path.join(dir, 'db.test.ts');
    fs.writeFileSync(file, 'const rows = db.query(`SELECT * FROM users WHERE id = ${id}`);\n');
    const findings = await sqlInjectionRule.check([file]);
    assert.equal(findings.length, 0);
    fs.rmSync(dir, { recursive: true });
  });

  it('skips comment lines', async () => {
    const { sqlInjectionRule } = await import('../src/core/static-rules/rules/sql-injection.ts');
    const dir = tmp();
    const file = path.join(dir, 'db.ts');
    fs.writeFileSync(file, '// const rows = db.query(`SELECT * FROM users WHERE id = ${userId}`);\n');
    const findings = await sqlInjectionRule.check([file]);
    assert.equal(findings.length, 0);
    fs.rmSync(dir, { recursive: true });
  });
});

// ── missing-auth ──────────────────────────────────────────────────────────────
describe('missing-auth', () => {
  it('flags API route with POST and no auth', async () => {
    const { missingAuthRule } = await import('../src/core/static-rules/rules/missing-auth.ts');
    const dir = tmp();
    // Must match API_ROUTE_PATTERN: app/api/**/route.ts
    const file = path.join(dir, 'app', 'api', 'users', 'route.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'export async function POST(req: Request) {\n  const body = await req.json();\n  return Response.json({ ok: true });\n}\n');
    const findings = await missingAuthRule.check([file]);
    assert.ok(findings.length > 0, 'expected missing-auth finding');
    assert.equal(findings[0]!.category, 'missing-auth');
    assert.equal(findings[0]!.severity, 'critical');
    fs.rmSync(dir, { recursive: true });
  });

  it('passes API route with getServerSession', async () => {
    const { missingAuthRule } = await import('../src/core/static-rules/rules/missing-auth.ts');
    const dir = tmp();
    const file = path.join(dir, 'app', 'api', 'users', 'route.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'import { getServerSession } from "next-auth";\nexport async function POST(req: Request) {\n  const session = await getServerSession();\n  return Response.json({ ok: true });\n}\n');
    const findings = await missingAuthRule.check([file]);
    assert.equal(findings.length, 0);
    fs.rmSync(dir, { recursive: true });
  });

  it('passes GET-only route with no auth', async () => {
    const { missingAuthRule } = await import('../src/core/static-rules/rules/missing-auth.ts');
    const dir = tmp();
    const file = path.join(dir, 'app', 'api', 'status', 'route.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'export async function GET() {\n  return Response.json({ status: "ok" });\n}\n');
    const findings = await missingAuthRule.check([file]);
    assert.equal(findings.length, 0);
    fs.rmSync(dir, { recursive: true });
  });

  it('skips non-API files', async () => {
    const { missingAuthRule } = await import('../src/core/static-rules/rules/missing-auth.ts');
    const dir = tmp();
    const file = path.join(dir, 'src', 'service.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'export async function POST(req: Request) {}\n');
    const findings = await missingAuthRule.check([file]);
    assert.equal(findings.length, 0);
    fs.rmSync(dir, { recursive: true });
  });

  it('passes route with Clerk auth', async () => {
    const { missingAuthRule } = await import('../src/core/static-rules/rules/missing-auth.ts');
    const dir = tmp();
    const file = path.join(dir, 'app', 'api', 'data', 'route.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'import { getAuth } from "@clerk/nextjs/server";\nexport async function DELETE(req: Request) {\n  const { userId } = getAuth(req);\n  return Response.json({ ok: true });\n}\n');
    const findings = await missingAuthRule.check([file]);
    assert.equal(findings.length, 0);
    fs.rmSync(dir, { recursive: true });
  });
});

// ── ssrf ──────────────────────────────────────────────────────────────────────
describe('ssrf', () => {
  it('flags fetch with user-controlled URL template', async () => {
    const { ssrfRule } = await import('../src/core/static-rules/rules/ssrf.ts');
    const dir = tmp();
    const file = path.join(dir, 'proxy.ts');
    fs.writeFileSync(file, 'const res = await fetch(`https://${req.query.host}/api/data`);\n');
    const findings = await ssrfRule.check([file]);
    assert.ok(findings.length > 0, 'expected ssrf finding');
    assert.equal(findings[0]!.category, 'ssrf');
    assert.equal(findings[0]!.severity, 'critical');
    fs.rmSync(dir, { recursive: true });
  });

  it('flags axios with user input', async () => {
    const { ssrfRule } = await import('../src/core/static-rules/rules/ssrf.ts');
    const dir = tmp();
    const file = path.join(dir, 'fetcher.ts');
    fs.writeFileSync(file, 'const resp = await axios.get(req.body.url);\n');
    const findings = await ssrfRule.check([file]);
    assert.ok(findings.length > 0);
    fs.rmSync(dir, { recursive: true });
  });

  it('passes fetch with static URL', async () => {
    const { ssrfRule } = await import('../src/core/static-rules/rules/ssrf.ts');
    const dir = tmp();
    const file = path.join(dir, 'fetcher.ts');
    fs.writeFileSync(file, 'const res = await fetch("https://api.example.com/data");\n');
    const findings = await ssrfRule.check([file]);
    assert.equal(findings.length, 0);
    fs.rmSync(dir, { recursive: true });
  });

  it('passes fetch with allowlist validation', async () => {
    const { ssrfRule } = await import('../src/core/static-rules/rules/ssrf.ts');
    const dir = tmp();
    const file = path.join(dir, 'fetcher.ts');
    fs.writeFileSync(file, 'const allowlist = ["api.example.com"];\nif (!allowlist.includes(new URL(url).hostname)) throw new Error();\nconst res = await fetch(url);\n');
    const findings = await ssrfRule.check([file]);
    assert.equal(findings.length, 0);
    fs.rmSync(dir, { recursive: true });
  });

  it('skips test files', async () => {
    const { ssrfRule } = await import('../src/core/static-rules/rules/ssrf.ts');
    const dir = tmp();
    const file = path.join(dir, 'proxy.test.ts');
    fs.writeFileSync(file, 'const res = await fetch(`https://${req.query.host}/api`);\n');
    const findings = await ssrfRule.check([file]);
    assert.equal(findings.length, 0);
    fs.rmSync(dir, { recursive: true });
  });
});

// ── insecure-redirect ─────────────────────────────────────────────────────────
describe('insecure-redirect', () => {
  it('flags redirect with query param', async () => {
    const { insecureRedirectRule } = await import('../src/core/static-rules/rules/insecure-redirect.ts');
    const dir = tmp();
    const file = path.join(dir, 'handler.ts');
    fs.writeFileSync(file, 'redirect(req.query.returnUrl);\n');
    const findings = await insecureRedirectRule.check([file]);
    assert.ok(findings.length > 0, 'expected insecure-redirect finding');
    assert.equal(findings[0]!.category, 'insecure-redirect');
    assert.equal(findings[0]!.severity, 'warning');
    fs.rmSync(dir, { recursive: true });
  });

  it('flags NextResponse.redirect with user input', async () => {
    const { insecureRedirectRule } = await import('../src/core/static-rules/rules/insecure-redirect.ts');
    const dir = tmp();
    const file = path.join(dir, 'route.ts');
    fs.writeFileSync(file, 'return NextResponse.redirect(request.nextUrl.searchParams.get("next"));\n');
    const findings = await insecureRedirectRule.check([file]);
    assert.ok(findings.length > 0);
    fs.rmSync(dir, { recursive: true });
  });

  it('passes redirect with startsWith validation', async () => {
    const { insecureRedirectRule } = await import('../src/core/static-rules/rules/insecure-redirect.ts');
    const dir = tmp();
    const file = path.join(dir, 'route.ts');
    fs.writeFileSync(file, 'if (!redirectUrl.startsWith("/")) throw new Error();\nredirect(redirectUrl);\n');
    const findings = await insecureRedirectRule.check([file]);
    assert.equal(findings.length, 0);
    fs.rmSync(dir, { recursive: true });
  });

  it('passes redirect to static string', async () => {
    const { insecureRedirectRule } = await import('../src/core/static-rules/rules/insecure-redirect.ts');
    const dir = tmp();
    const file = path.join(dir, 'route.ts');
    fs.writeFileSync(file, 'redirect("/dashboard");\n');
    const findings = await insecureRedirectRule.check([file]);
    assert.equal(findings.length, 0);
    fs.rmSync(dir, { recursive: true });
  });

  it('skips test files', async () => {
    const { insecureRedirectRule } = await import('../src/core/static-rules/rules/insecure-redirect.ts');
    const dir = tmp();
    const file = path.join(dir, 'handler.test.ts');
    fs.writeFileSync(file, 'redirect(req.query.returnUrl);\n');
    const findings = await insecureRedirectRule.check([file]);
    assert.equal(findings.length, 0);
    fs.rmSync(dir, { recursive: true });
  });
});

// ── registry includes security rules ─────────────────────────────────────────
describe('registry security rules', () => {
  it('lists all four security rules', async () => {
    const { listAvailableRules } = await import('../src/core/static-rules/registry.ts');
    const names = listAvailableRules();
    for (const name of ['sql-injection', 'missing-auth', 'ssrf', 'insecure-redirect']) {
      assert.ok(names.includes(name), `missing: ${name}`);
    }
  });

  it('loads security rules by name', async () => {
    const { loadRulesFromConfig } = await import('../src/core/static-rules/registry.ts');
    const rules = await loadRulesFromConfig(['sql-injection', 'missing-auth', 'ssrf', 'insecure-redirect']);
    assert.equal(rules.length, 4);
    const ruleNames = rules.map(r => r.name);
    assert.ok(ruleNames.includes('sql-injection'));
    assert.ok(ruleNames.includes('ssrf'));
  });
});
