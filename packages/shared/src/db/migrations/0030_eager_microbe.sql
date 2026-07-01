ALTER TABLE "hash_items" ADD COLUMN "username" varchar(255);--> statement-breakpoint
ALTER TABLE "hash_items" ADD COLUMN "source" varchar(32);--> statement-breakpoint
CREATE INDEX "hash_items_hash_value_idx" ON "hash_items" USING btree ("hash_value");--> statement-breakpoint
UPDATE hash_items SET username = metadata->>'username' WHERE metadata ? 'username';
