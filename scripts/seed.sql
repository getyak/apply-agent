-- Seed data for Relay/Vantage MVP
-- Run: psql $DATABASE_URL -f scripts/seed.sql

-- Seed jobs matching frontend store data
INSERT INTO jobs (id, company, role_title, url, source, jd_text, parsed, posted_date, is_active)
VALUES
  (
    'a0000000-0000-0000-0000-000000000001',
    'Linear', 'Senior Frontend Engineer', 'https://linear.app/careers/senior-frontend',
    'greenhouse',
    'We are looking for a Senior Frontend Engineer to join our team. You will work on our core product experience, building fast and beautiful interfaces.',
    '{"skills":["React","TypeScript","Next.js","CSS","GraphQL","Performance"],"level":"senior","salary_min":180000,"salary_max":220000,"locations":["San Francisco","Remote"],"remote":true}'::jsonb,
    NOW() - INTERVAL '2 days', true
  ),
  (
    'a0000000-0000-0000-0000-000000000002',
    'Ramp', 'Full-Stack Engineer', 'https://ramp.com/careers/full-stack',
    'lever',
    'Join Ramp as a Full-Stack Engineer and help build the next generation of corporate finance tools.',
    '{"skills":["React","TypeScript","Python","PostgreSQL","Redis","AWS"],"level":"senior","salary_min":170000,"salary_max":210000,"locations":["New York","Remote"],"remote":true}'::jsonb,
    NOW() - INTERVAL '1 day', true
  ),
  (
    'a0000000-0000-0000-0000-000000000003',
    'Vercel', 'Product Designer', 'https://vercel.com/careers/product-designer',
    'greenhouse',
    'Design the future of web development at Vercel. You will shape the developer experience for millions of developers worldwide.',
    '{"skills":["Figma","Design Systems","Prototyping","User Research","CSS","React"],"level":"senior","salary_min":160000,"salary_max":200000,"locations":["San Francisco","Remote"],"remote":true}'::jsonb,
    NOW() - INTERVAL '3 days', true
  ),
  (
    'a0000000-0000-0000-0000-000000000004',
    'Notion', 'Design Engineer', 'https://notion.so/careers/design-engineer',
    'lever',
    'Bridge the gap between design and engineering at Notion. Build beautiful, accessible interfaces that millions of people use daily.',
    '{"skills":["React","TypeScript","CSS","Animation","Figma","Accessibility"],"level":"mid","salary_min":150000,"salary_max":190000,"locations":["San Francisco","New York"],"remote":false}'::jsonb,
    NOW() - INTERVAL '5 days', true
  ),
  (
    'a0000000-0000-0000-0000-000000000005',
    'Stripe', 'Staff Engineer, Payments', 'https://stripe.com/careers/staff-payments',
    'greenhouse',
    'Help scale the internet economy at Stripe. Design and implement payment systems that process billions of dollars.',
    '{"skills":["Ruby","Go","TypeScript","Distributed Systems","PostgreSQL","Kafka"],"level":"staff","salary_min":220000,"salary_max":300000,"locations":["San Francisco","Seattle","Remote"],"remote":true}'::jsonb,
    NOW() - INTERVAL '1 day', true
  ),
  (
    'a0000000-0000-0000-0000-000000000006',
    'Anthropic', 'Software Engineer, Platform', 'https://anthropic.com/careers/platform-eng',
    'greenhouse',
    'Build the infrastructure that powers Claude. Work on distributed systems, ML infrastructure, and developer tools.',
    '{"skills":["Python","Rust","Kubernetes","Docker","PostgreSQL","ML Infrastructure"],"level":"senior","salary_min":200000,"salary_max":280000,"locations":["San Francisco"],"remote":false}'::jsonb,
    NOW() - INTERVAL '4 days', true
  ),
  (
    'a0000000-0000-0000-0000-000000000007',
    'Figma', 'Frontend Engineer, Editor', 'https://figma.com/careers/frontend-editor',
    'lever',
    'Work on the core editor experience at Figma. Build high-performance rendering and interaction systems in the browser.',
    '{"skills":["TypeScript","WebGL","Canvas API","Performance","React","C++/Wasm"],"level":"senior","salary_min":190000,"salary_max":240000,"locations":["San Francisco","New York"],"remote":false}'::jsonb,
    NOW() - INTERVAL '6 days', true
  ),
  (
    'a0000000-0000-0000-0000-000000000008',
    'Datadog', 'Backend Engineer, Logs', 'https://datadog.com/careers/backend-logs',
    'greenhouse',
    'Build systems that ingest and analyze petabytes of log data. Performance and reliability are critical.',
    '{"skills":["Go","Kafka","Elasticsearch","Kubernetes","Distributed Systems","Python"],"level":"senior","salary_min":180000,"salary_max":240000,"locations":["New York","Boston","Remote"],"remote":true}'::jsonb,
    NOW() - INTERVAL '2 days', true
  )
ON CONFLICT (id) DO NOTHING;

-- Verify
SELECT company, role_title, (parsed->>'level') AS level FROM jobs ORDER BY posted_date DESC;
