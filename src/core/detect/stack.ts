import * as fs from 'node:fs';
import * as path from 'node:path';

function readJson(p: string): Record<string, unknown> | null {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function fileContains(p: string, needle: string): boolean {
  try { return fs.readFileSync(p, 'utf8').includes(needle); } catch { return false; }
}

function readFile(p: string): string {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function version(deps: Record<string, string>, name: string): string | null {
  const v = deps[name];
  if (!v) return null;
  return v.replace(/^[\^~>=<\s]+/, '').split('.')[0] ?? null;
}

/**
 * Infers a human-readable stack description from project files.
 * Returns null if nothing definitive is found (caller should omit from prompt).
 */
export function detectStack(cwd: string): string | null {
  // Go
  const goMod = path.join(cwd, 'go.mod');
  if (fs.existsSync(goMod)) {
    const content = readFile(goMod);
    const parts = ['Go'];
    if (content.includes('gin-gonic/gin')) parts.push('Gin');
    else if (content.includes('labstack/echo')) parts.push('Echo');
    else if (content.includes('gofiber/fiber')) parts.push('Fiber');
    else if (content.includes('go-chi/chi')) parts.push('Chi');
    if (content.includes('database/sql') || content.includes('sqlx') || content.includes('pgx')) parts.push('PostgreSQL');
    if (content.includes('gorm.io')) parts.push('GORM');
    if (content.includes('redis')) parts.push('Redis');
    return parts.join(' + ');
  }

  // Rust
  const cargoToml = path.join(cwd, 'Cargo.toml');
  if (fs.existsSync(cargoToml)) {
    const content = readFile(cargoToml);
    const parts = ['Rust'];
    if (content.includes('actix-web')) parts.push('Actix-Web');
    else if (content.includes('axum')) parts.push('Axum');
    else if (content.includes('warp')) parts.push('Warp');
    if (content.includes('sqlx') || content.includes('diesel')) parts.push('PostgreSQL');
    if (content.includes('serde')) parts.push('Serde');
    if (content.includes('tokio')) parts.push('Tokio async');
    return parts.join(' + ');
  }

  // Ruby / Rails
  const gemfile = path.join(cwd, 'Gemfile');
  if (fs.existsSync(gemfile)) {
    const content = readFile(gemfile);
    const parts: string[] = [];
    if (content.includes("'rails'") || content.includes('"rails"')) parts.push('Ruby on Rails');
    else if (content.includes("'sinatra'") || content.includes('"sinatra"')) parts.push('Sinatra');
    else parts.push('Ruby');
    if (content.includes('pg') || content.includes('postgresql')) parts.push('PostgreSQL');
    else if (content.includes('mysql')) parts.push('MySQL');
    else if (content.includes('sqlite')) parts.push('SQLite');
    if (content.includes('rspec')) parts.push('RSpec');
    if (content.includes('sidekiq')) parts.push('Sidekiq');
    return parts.join(' + ');
  }

  // Python
  const reqTxt = path.join(cwd, 'requirements.txt');
  const pyproject = path.join(cwd, 'pyproject.toml');
  const hasFastapi = fileContains(reqTxt, 'fastapi') || fileContains(pyproject, 'fastapi');
  const hasDjango  = fileContains(reqTxt, 'django')  || fileContains(pyproject, 'django');
  const hasFlask   = fileContains(reqTxt, 'flask')   || fileContains(pyproject, 'flask');
  if (hasFastapi || hasDjango || hasFlask || fs.existsSync(reqTxt) || fs.existsSync(pyproject)) {
    const parts: string[] = [];
    if (hasFastapi) parts.push('FastAPI');
    else if (hasDjango) parts.push('Django');
    else if (hasFlask) parts.push('Flask');
    else parts.push('Python');
    const combined = readFile(reqTxt) + readFile(pyproject);
    if (combined.includes('sqlalchemy') || combined.includes('SQLAlchemy')) parts.push('SQLAlchemy');
    if (combined.includes('postgresql') || combined.includes('psycopg')) parts.push('PostgreSQL');
    if (combined.includes('pydantic')) parts.push('Pydantic');
    if (combined.includes('celery')) parts.push('Celery');
    return parts.join(' + ');
  }

  // Node / JS / TS
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  const pkg = readJson(pkgPath);
  if (!pkg) return null;

  const deps: Record<string, string> = {
    ...(pkg['dependencies'] as Record<string, string> ?? {}),
    ...(pkg['devDependencies'] as Record<string, string> ?? {}),
  };

  const parts: string[] = [];
  const isTs = 'typescript' in deps || fs.existsSync(path.join(cwd, 'tsconfig.json'));

  // Framework
  if ('next' in deps) {
    const v = version(deps, 'next');
    parts.push(v ? `Next.js ${v}` : 'Next.js');
  } else if ('nuxt' in deps || 'nuxt3' in deps) {
    parts.push('Nuxt');
  } else if ('remix' in deps || '@remix-run/react' in deps) {
    parts.push('Remix');
  } else if ('astro' in deps) {
    parts.push('Astro');
  } else if ('express' in deps) {
    parts.push('Express');
  } else if ('fastify' in deps) {
    parts.push('Fastify');
  } else if ('hono' in deps) {
    parts.push('Hono');
  } else if ('react' in deps) {
    parts.push('React');
  } else if ('vue' in deps) {
    parts.push('Vue');
  } else if ('svelte' in deps || '@sveltejs/kit' in deps) {
    parts.push('SvelteKit');
  }

  // Database / ORM
  if ('@supabase/supabase-js' in deps) parts.push('Supabase');
  if ('prisma' in deps || '@prisma/client' in deps) parts.push('Prisma');
  if ('drizzle-orm' in deps) parts.push('Drizzle');
  if ('typeorm' in deps) parts.push('TypeORM');
  if ('mongoose' in deps) parts.push('MongoDB');

  // Meta-frameworks / routers
  if ('@trpc/server' in deps) parts.push('tRPC');
  if ('graphql' in deps && ('apollo-server' in deps || '@apollo/server' in deps)) parts.push('GraphQL/Apollo');

  // Auth
  if ('next-auth' in deps || '@auth/core' in deps) parts.push('NextAuth');
  if ('clerk' in deps || '@clerk/nextjs' in deps) parts.push('Clerk');

  // UI
  if ('tailwindcss' in deps) parts.push('Tailwind CSS');

  // Language suffix
  if (isTs) parts.push('TypeScript');

  if (parts.length === 0) return null;
  return parts.join(' + ');
}
