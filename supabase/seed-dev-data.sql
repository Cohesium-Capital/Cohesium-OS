-- seed-dev-data.sql : sample data for the DEV database only.
-- Paste into the Supabase SQL editor on the cohesium-dev project.
-- Idempotent: running twice won't duplicate (guarded by org domains).
--
-- Populates every pipeline stage so all app pages have content:
--   MSPs (acq targets) -> customers -> contacts (various stages)
--   an open sourcing batch with contacts pending grading
--   drafted touches (planned/approved) + one sent-and-replied thread
--   an interaction + extraction for the reply

do $$
declare
  msp_tc uuid; msp_bw uuid; msp_ns uuid;
  org1 uuid; org2 uuid; org3 uuid; org4 uuid; org5 uuid; org6 uuid;
  c1 uuid; c2 uuid; c3 uuid; c4 uuid; c5 uuid; c6 uuid; c7 uuid; c8 uuid;
  demo_batch uuid; demo_run uuid; sourcing_pv uuid;
  t_sent uuid;
begin
  if exists (select 1 from public.organizations where domain = 'techcarems.example') then
    raise notice 'seed already applied, skipping';
    return;
  end if;

  -- ---------- MSP acquisition targets ----------
  insert into public.organizations (name, domain, kind, is_acq_target, hq_city, hq_state, confidence, reviewed, notes)
  values ('TechCare Managed Services', 'techcarems.example', 'msp', true, 'Richmond', 'VA', 'high', true,
          'Aging owner, strong SMB base in legal/professional services.')
  returning id into msp_tc;

  insert into public.organizations (name, domain, kind, is_acq_target, hq_city, hq_state, confidence, reviewed, notes)
  values ('BlueWave IT Partners', 'bluewaveit.example', 'msp', true, 'Charlotte', 'NC', 'medium', true,
          'Mid-market focus, healthcare verticals.')
  returning id into msp_bw;

  insert into public.organizations (name, domain, kind, is_acq_target, hq_city, hq_state, confidence, reviewed, notes)
  values ('NetSecure Solutions', 'netsecure.example', 'msp', false, 'Raleigh', 'NC', 'low', false,
          'Unvetted; found via Clutch listing.')
  returning id into msp_ns;

  -- ---------- customer organizations ----------
  insert into public.organizations (name, domain, kind, current_msp_id, hq_city, hq_state, confidence, source_url, reviewed)
  values
    ('Harbor Law Group',        'harborlaw.example',    'customer', msp_tc, 'Richmond',  'VA', 'high',   'https://techcarems.example/case-studies/harbor-law', true),
    ('Piedmont Accounting Co',  'piedmontacct.example', 'customer', msp_tc, 'Richmond',  'VA', 'high',   'https://techcarems.example/clients', true),
    ('Riverside Dental Group',  'riversidedental.example','customer', msp_tc, 'Norfolk', 'VA', 'medium', 'https://clutch.co/profile/techcare#reviews', true),
    ('Carolina Freight Lines',  'carolinafreight.example','customer', msp_bw, 'Charlotte','NC', 'high',  'https://bluewaveit.example/testimonials', true),
    ('Summit Family Medicine',  'summitfammed.example', 'customer', msp_bw, 'Durham',    'NC', 'medium', 'https://g2.com/products/bluewave/reviews', false),
    ('Coastal Realty Partners', 'coastalrealty.example','customer', msp_ns, 'Wilmington','NC', 'low',    null, false);

  select id into org1 from public.organizations where domain = 'harborlaw.example';
  select id into org2 from public.organizations where domain = 'piedmontacct.example';
  select id into org3 from public.organizations where domain = 'riversidedental.example';
  select id into org4 from public.organizations where domain = 'carolinafreight.example';
  select id into org5 from public.organizations where domain = 'summitfammed.example';
  select id into org6 from public.organizations where domain = 'coastalrealty.example';

  -- ---------- eval batch: open, pending grading ----------
  insert into public.batches (module, label, gate_status)
  values ('sourcing', 'demo: VA/NC customers of TechCare + BlueWave', 'open')
  returning id into demo_batch;

  select id into sourcing_pv from public.prompt_versions where module = 'sourcing' and version = 1;

  insert into public.runs (module, prompt_version_id, batch_id, executor, provider_label, status, config)
  values ('sourcing', sourcing_pv, demo_batch, 'copy_paste', 'claude.ai', 'review_ready',
          '{"region":"VA/NC","countPer":5}'::jsonb)
  returning id into demo_run;

  -- ---------- contacts across pipeline stages ----------
  -- graded-pipeline contacts (sampled, pending review) in the demo batch
  insert into public.contacts (organization_id, full_name, persona, title, email, linkedin_url, city,
                               enrichment_status, stage, source, confidence, source_url, reviewed,
                               batch_id, sampled, review_status, evidence)
  values
    (org1, 'Margaret Chen',  'owner',      'Managing Partner',  'mchen@harborlaw.example',    'https://linkedin.com/in/margaretchen-example',  'Richmond', 'enriched', 'sourced', 'case study', 'high',
     'https://techcarems.example/case-studies/harbor-law', false, demo_batch, true, 'pending_review',
     '[{"url":"https://techcarems.example/case-studies/harbor-law","note":"named in case study"}]'::jsonb),
    (org2, 'David Okafor',   'head_of_it', 'IT Director',       'dokafor@piedmontacct.example','https://linkedin.com/in/davidokafor-example',  'Richmond', 'enriched', 'sourced', 'client page', 'high',
     'https://techcarems.example/clients', false, demo_batch, true, 'pending_review',
     '[{"url":"https://techcarems.example/clients","note":"logo wall + LinkedIn title match"}]'::jsonb),
    (org3, 'Susan Alvarez',  'owner',      'Practice Owner',    null,                          'https://linkedin.com/in/susanalvarez-example', 'Norfolk',  'pending',  'sourced', 'review site', 'medium',
     'https://clutch.co/profile/techcare#reviews', false, demo_batch, true, 'pending_review',
     '[{"url":"https://clutch.co/profile/techcare#reviews","note":"review signed S.A., practice name"}]'::jsonb),
    (org5, 'Priya Raman',    'head_of_it', 'Systems Manager',   null,                          null,                                            'Durham',   'pending',  'sourced', 'g2 review', 'low',
     'https://g2.com/products/bluewave/reviews', false, demo_batch, true, 'pending_review',
     '[{"url":"https://g2.com/products/bluewave/reviews","note":"first-name review; title inferred"}]'::jsonb);

  -- legacy/approved contacts further down the funnel
  insert into public.contacts (organization_id, full_name, persona, title, email, linkedin_url, city,
                               enrichment_status, personalization, stage, responded, responded_at, source,
                               confidence, reviewed, sampled, review_status)
  values
    (org4, 'James Whitfield', 'owner',     'President',        'jwhitfield@carolinafreight.example', 'https://linkedin.com/in/jameswhitfield-example', 'Charlotte', 'enriched',
     'Spoke on a logistics-tech panel at CSCMP EDGE last fall.', 'in_conversation', true, now() - interval '3 days', 'testimonial', 'high', true, false, 'approved'),
    (org4, 'Lena Torres',     'head_of_it','VP of Technology', 'ltorres@carolinafreight.example',    'https://linkedin.com/in/lenatorres-example',     'Charlotte', 'enriched',
     'Recently posted about their WMS migration.', 'contacted', false, null, 'testimonial', 'high', true, false, 'approved'),
    (org1, 'Robert Ellis',    'other',     'Office Manager',   'rellis@harborlaw.example',           null,                                             'Richmond',  'low_confidence',
     null, 'sourced', false, null, 'case study', 'medium', true, false, 'approved'),
    (org6, 'Dana Kim',        'owner',     'Broker-in-Charge', null,                                 'https://linkedin.com/in/danakim-example',        'Wilmington','pending',
     null, 'sourced', false, null, 'directory', 'low', false, false, 'approved');

  select id into c1 from public.contacts where full_name = 'Margaret Chen';
  select id into c2 from public.contacts where full_name = 'David Okafor';
  select id into c5 from public.contacts where full_name = 'James Whitfield';
  select id into c6 from public.contacts where full_name = 'Lena Torres';

  -- ---------- touches: drafted, queued, sent ----------
  -- planned drafts awaiting approval in the Send queue
  insert into public.touches (contact_id, channel, direction, sequence_step, status, subject, body, approved)
  values
    (c6, 'email', 'outbound', 1, 'planned',
     'your WMS migration and managed IT',
     'Hi Lena, cold email, so I''ll be quick. I''m a cofounder of Cohesium, an investment firm researching the managed IT market. Saw your post on the WMS migration at Carolina Freight. Would love 15 minutes on how companies like yours work with IT providers. Not selling anything.',
     true),
    (c6, 'linkedin', 'outbound', 1, 'planned', null,
     'Hi Lena, researching how mid-size logistics firms work with managed IT providers (not selling). Your WMS migration post caught my eye. Open to a quick chat?',
     false);

  -- a sent email that got a reply (feeds the interaction below)
  insert into public.touches (contact_id, channel, direction, sequence_step, status, subject, body, approved, provider, sent_at)
  values
    (c5, 'email', 'outbound', 1, 'replied',
     'quick question about IT at Carolina Freight',
     'Hi James, cold email, acknowledged. I''m a cofounder of Cohesium, an investment firm. We learn by talking to experienced operators. Caught your CSCMP EDGE panel last fall. Would value your take on how freight companies work with managed IT providers. Ten minutes, nothing sold.',
     true, 'smtp', now() - interval '5 days')
  returning id into t_sent;

  -- ---------- the reply: interaction + extraction ----------
  insert into public.interactions (contact_id, channel, occurred_at, raw_content)
  values
    (c5, 'email', now() - interval '3 days',
     'Happy to chat. We''ve been with BlueWave for about four years. Honestly they''re fine on tickets but strategic guidance is thin, and their after-hours response has slipped since they lost two engineers. We run mostly M365, some on-prem file servers we''d love to retire. My cell is below - James');

  insert into public.extractions (interaction_id, current_msp, satisfaction, switching_intent, owner_referenced,
                                  tech_stack, pain_points, summary, model_name, prompt_version)
  select i.id, 'BlueWave IT Partners', 'neutral', 'passive', true,
         array['Microsoft 365','on-prem file servers'],
         array['thin strategic guidance','slower after-hours response','engineer attrition at MSP'],
         'Open to conversation. Four years with BlueWave; operationally fine but strategically thin, after-hours slipping. Wants to retire on-prem servers.',
         'seed-data', 'v1'
  from public.interactions i
  where i.contact_id = c5
  limit 1;

  -- ---------- sourcing run yield log ----------
  insert into public.sourcing_runs (kind, target_msp_id, requested, inserted_orgs, inserted_contacts, skipped_duplicates, new_for_target)
  values
    ('customer', msp_tc, 5, 3, 4, 1, 3),
    ('customer', msp_bw, 5, 2, 3, 0, 2);

  raise notice 'seed complete';
end $$;
