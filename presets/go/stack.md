A Go application with:
- Go 1.22+, modules (go.mod/go.sum)
- PostgreSQL via pgx/v5 or database/sql
- Standard library HTTP or Chi/Gin router
- testify for tests, sqlmock or pgxmock for DB mocks
- golang-migrate or goose for schema migrations

Conventions:
- Repository pattern for DB access (internal/repository/)
- Errors wrapped with fmt.Errorf("...: %w", err)
- Context propagation on all DB and HTTP calls
- No global state — dependency injection via constructors
- pgx.Pool shared across request handlers

Things that should flag CRITICAL:
- fmt.Sprintf in SQL queries: fmt.Sprintf("WHERE id = %d", id)
- Ignoring sql.ErrNoRows without handling
- Missing context.Context in DB query calls
- Goroutines spawned without WaitGroup or context cancellation
- Secrets in Go source (API keys, DB passwords)
