"""The release phase: runs once, before traffic. Alembic-shaped without the ceremony."""
import os, psycopg
with psycopg.connect(os.environ["DATABASE_URL"]) as c:
    c.execute("create table if not exists contacts (id serial primary key, name text not null)")
    c.execute("insert into contacts (name) select 'ada' where not exists (select 1 from contacts)")
    print("migrated")
