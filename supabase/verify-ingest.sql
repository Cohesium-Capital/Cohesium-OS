-- verify-ingest.sql : sanity checks after the two agent research runs.
select kind, count(*)::int as orgs, count(domain)::int as with_domain,
       count(*) filter (where confidence = 'low')::int as low_conf
from public.organizations group by kind order by kind;

-- customer -> MSP linkage (should resolve to run-1 MSPs, no stubs)
select c.name as customer, m.name as msp, c.confidence
from public.organizations c
left join public.organizations m on m.id = c.current_msp_id
where c.kind = 'customer' order by m.name nulls last, c.name;

-- runs + batches
select r.module, r.status, b.label, b.gate_status,
       (select count(*) from public.contacts ct where ct.batch_id = b.id)::int as contacts,
       (select count(*) from public.contacts ct where ct.batch_id = b.id and ct.sampled)::int as sampled
from public.runs r join public.batches b on b.id = r.batch_id
order by r.created_at;

-- grade queue: sampled contacts pending review
select ct.full_name, ct.title, o.name as org, ct.confidence, ct.review_status
from public.contacts ct join public.organizations o on o.id = ct.organization_id
where ct.sampled and ct.review_status = 'pending_review'
order by o.name;
