A Python FastAPI application with:
- FastAPI, Python 3.11+, SQLAlchemy 2.x (async), Alembic migrations
- Pydantic v2 for request/response models and settings
- PostgreSQL via asyncpg driver
- JWT authentication via python-jose or authlib
- pytest for tests

Conventions:
- Dependency injection via FastAPI Depends()
- DB session injected per-request (not global)
- Pydantic BaseSettings for all config (no os.environ direct access)
- Alembic for all schema changes (never raw CREATE TABLE in code)
- Async endpoints where possible

Things that should flag CRITICAL:
- f-string SQL: f"SELECT * FROM users WHERE id = {user_id}"
- Unauthenticated POST/PUT/DELETE endpoints on non-public paths
- Secrets hardcoded in Python files
- os.environ direct access instead of Pydantic settings
- Synchronous DB calls in async endpoints (blocking event loop)
