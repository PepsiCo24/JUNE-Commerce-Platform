-- AlterEnum
CREATE TYPE "PostCategory" AS ENUM ('DISCUSSION', 'QUESTION', 'SHOWCASE', 'GUIDE', 'RESOURCE', 'OTHER');

-- AlterTable
ALTER TABLE "posts" ADD COLUMN "category" "PostCategory" NOT NULL DEFAULT 'DISCUSSION';

-- CreateIndex
CREATE INDEX "posts_status_category_likeCount_publishedAt_idx" ON "posts"("status", "category", "likeCount" DESC, "publishedAt" DESC);
