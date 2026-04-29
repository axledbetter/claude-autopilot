A Python application (general — not framework-specific). Common patterns:
- Python 3.10+, virtualenv or uv/poetry for deps
- pytest for tests, ruff or flake8 for lint, mypy for types
- pyproject.toml for project config (PEP 621) or requirements.txt
- asyncio + aiohttp / httpx for async I/O
- Pydantic v2 or dataclasses for data models
- python-dotenv or os.environ for config (no Pydantic Settings assumed)

Conventions to encourage:
- Type hints on public functions
- f-strings over .format() / %
- pathlib over os.path
- contextmanagers for resources
- explicit exception types, no bare `except:`

Things that should flag CRITICAL:
- f-string SQL: f"SELECT * FROM users WHERE id = {user_id}"
- Bare `except:` or `except Exception:` swallowing errors
- Hardcoded secrets / API keys in source files
- subprocess.run with shell=True on user-controlled input
- pickle.load on untrusted data
- eval / exec on user input
- Synchronous blocking calls inside async def (requests, time.sleep, open)

Things that should flag WARNING:
- Mutable default arguments (def f(x=[])  → bug)
- Missing type hints on public functions
- Broad exception catches that hide root causes
- print() statements left in non-CLI code (use logging)
- TODO / FIXME comments without owners or context
