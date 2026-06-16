-- 011_sample_rate.sql
-- Practical grading load: sample ~20% of each batch (deterministic FNV-1a) rather
-- than grading every record. min_sample_size stays 20, so small batches are still
-- graded in full. Once the sampled subset clears the error threshold, the whole
-- batch — sampled and unsampled riders — advances. Adjustable later in Settings.

update public.settings set sample_rate = 0.2
where module in ('sourcing', 'enrichment', 'personalization', 'drafting');
