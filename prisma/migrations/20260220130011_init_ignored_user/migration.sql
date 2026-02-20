-- DropIndex
DROP INDEX "Streamer_uid_key";

-- CreateTable
CREATE TABLE "IgnoredUser" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "uid" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "IgnoredUser_uid_key" ON "IgnoredUser"("uid");
