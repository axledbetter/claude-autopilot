A Ruby on Rails 7 application with:
- Rails 7.x, Ruby 3.2+, PostgreSQL
- RSpec for tests (spec/), FactoryBot for fixtures
- Active Record ORM (migrations in db/migrate/)
- Devise or similar for authentication
- Turbo/Stimulus for frontend

Conventions:
- Fat models, thin controllers
- Service objects in app/services/ for complex business logic
- Migrations are irreversible destructive operations — always write down/up
- Strong parameters in controllers for all form inputs
- Background jobs in app/jobs/ via Sidekiq

Things that should flag CRITICAL:
- Raw SQL interpolation: User.where("name = '#{params[:name]}'")
- Mass assignment without strong params
- Secrets in application.rb or initializers (not credentials.yml.enc)
- Missing foreign key constraints in migrations
- N+1 queries (missing .includes() on associations)
