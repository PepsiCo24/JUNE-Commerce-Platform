-- AlterTable
ALTER TABLE "users" ADD COLUMN     "location" VARCHAR(100),
ADD COLUMN     "preferences" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "website" VARCHAR(200);
