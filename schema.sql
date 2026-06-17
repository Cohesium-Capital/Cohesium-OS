-- schema.sql : MSP intelligence engine (Postgres / Supabase)
-- One datastore, both flows (MSP acquisition + customer intelligence).
-- Text + CHECK constraints are used over native enums so the schema stays easy
-- to evolve as the dataset grows.

create extension if not exists "pgcrypto";  -- for gen_random_uuid()

-- Companies: MSP acquisition targets, their customers, and the MSPs that
-- customers currently use. One table, related to itself.
create table organizations (
    id              uuid primary key default gen_random_uuid(),
    name            text not null,
    domain          text unique,
    kind            text not null default 'unknown'
                      check (kind in ('msp', 'customer', 'unknown')),
    is_acq_target   boolean not null default false,    -- flag an org as a Cohesium target
    current_msp_id  uuid references organizations(id), -- for a customer: the MSP they use
    hq_city         text,
    hq_state        text,
    notes           text,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

-- People we contact. Persona drives the messaging angle.
create table contacts (
    id                uuid primary key default gen_random_uuid(),
    organization_id   uuid not null references organizations(id) on delete cascade,
    full_name         text,
    persona           text check (persona in ('owner', 'head_of_it', 'other')),
    title             text,
    email             text,
    phone             text,
    linkedin_url      text,
    city              text,
    enrichment_status text not null default 'pending'
                        check (enrichment_status in ('pending','enriched','low_confidence','failed')),
    personalization   text,                            -- the researched hook (stage 2b)
    stage             text not null default 'sourced'
                        check (stage in ('sourced','enriched','queued','contacted',
                                         'responded','in_conversation','intro_path','nurturing','closed')),
    responded         boolean not null default false,  -- the global stop flag
    responded_at      timestamptz,
    source            text,                            -- where we found them
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now()
);

-- Outbound and inbound touches across every channel.
create table touches (
    id            uuid primary key default gen_random_uuid(),
    contact_id    uuid not null references contacts(id) on delete cascade,
    channel       text not null check (channel in ('email','linkedin','letter','call')),
    direction     text not null check (direction in ('outbound','inbound')),
    sequence_step int,
    status        text not null default 'planned'
                    check (status in ('planned','queued','sent','delivered','bounced','replied','failed')),
    scheduled_at  timestamptz,
    sent_at       timestamptz,
    created_at    timestamptz not null default now()
);

-- The raw source of truth: a reply, a thread, a call transcript. Kept forever.
create table interactions (
    id           uuid primary key default gen_random_uuid(),
    contact_id   uuid not null references contacts(id) on delete cascade,
    channel      text not null check (channel in ('email','linkedin','call','other')),
    occurred_at  timestamptz not null default now(),
    raw_content  text not null,
    created_at   timestamptz not null default now()
);

-- Structured insight extracted from one interaction. Versioned and model-stamped
-- so you can re-extract the whole archive when the schema grows.
create table extractions (
    id               uuid primary key default gen_random_uuid(),
    interaction_id   uuid not null references interactions(id) on delete cascade,
    current_msp      text,
    satisfaction     text check (satisfaction in ('positive','neutral','negative','unknown')),
    switching_intent text check (switching_intent in ('none','passive','active','unknown')),
    owner_referenced boolean default false,
    tech_stack       text[] default '{}',
    pain_points      text[] default '{}',
    summary          text,
    extra            jsonb default '{}',
    model_name       text not null,                    -- which brain produced this
    prompt_version   text not null,
    extracted_at     timestamptz not null default now()
);

-- Warm paths: a customer contact who can introduce us to a target MSP. (Goal 1)
create table intro_paths (
    id              uuid primary key default gen_random_uuid(),
    from_contact_id uuid not null references contacts(id) on delete cascade,
    to_msp_id       uuid not null references organizations(id) on delete cascade,
    strength        text check (strength in ('weak','medium','strong','confirmed')),
    status          text not null default 'identified'
                      check (status in ('identified','requested','offered','made','declined')),
    notes           text,
    created_at      timestamptz not null default now()
);

create index on contacts (organization_id);
create index on contacts (stage);
create index on touches (contact_id);
create index on interactions (contact_id);
create index on extractions (interaction_id);
create index on intro_paths (to_msp_id);

-- Example payoff query: rank MSP targets by how happy their customers are.
-- This is the scorecard that re-ranks acquisition targets before you ever
-- send a letter.
--
--   select o.name,
--          count(*) filter (where e.satisfaction = 'negative') as unhappy,
--          count(*) filter (where e.satisfaction = 'positive') as happy
--   from organizations o
--   join contacts c       on c.organization_id = o.current_msp_id
--   join interactions i   on i.contact_id = c.id
--   join extractions e    on e.interaction_id = i.id
--   where o.is_acq_target
--   group by o.name;
