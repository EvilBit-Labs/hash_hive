ALTER TABLE "mask_lists" ADD COLUMN "compression_encoding" varchar(32) DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "rule_lists" ADD COLUMN "compression_encoding" varchar(32) DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "word_lists" ADD COLUMN "compression_encoding" varchar(32) DEFAULT 'none' NOT NULL;
