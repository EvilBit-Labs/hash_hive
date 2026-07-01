ALTER TABLE "hash_items" ADD CONSTRAINT "hash_items_source_chk" CHECK ("hash_items"."source" IS NULL OR "hash_items"."source" IN ('upload', 'import'));
