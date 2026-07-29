CREATE INDEX "hash_items_super_export_keyset_idx" ON "hash_items" USING btree ("hash_list_id",coalesce("detected_hashcat_mode", -1),"hash_value");
