-- CreateTable
CREATE TABLE "factories" (
    "id" SERIAL NOT NULL,
    "chainId" INTEGER NOT NULL,
    "address" VARCHAR(42) NOT NULL,
    "version" VARCHAR(32),
    "deploymentBlock" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "factories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "splits" (
    "id" SERIAL NOT NULL,
    "factoryId" INTEGER NOT NULL,
    "chainId" INTEGER NOT NULL,
    "address" VARCHAR(42) NOT NULL,
    "title" VARCHAR(256) NOT NULL,
    "manager" VARCHAR(42) NOT NULL,
    "factoryIndex" INTEGER NOT NULL,
    "createdAtBlock" INTEGER NOT NULL,
    "createdAtTx" VARCHAR(66) NOT NULL,
    "createdAt" TIMESTAMP(3),

    CONSTRAINT "splits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chain_events" (
    "id" BIGSERIAL NOT NULL,
    "chainId" INTEGER NOT NULL,
    "address" VARCHAR(42) NOT NULL,
    "splitId" INTEGER,
    "eventName" VARCHAR(48) NOT NULL,
    "blockNumber" INTEGER NOT NULL,
    "blockHash" VARCHAR(66) NOT NULL,
    "transactionHash" VARCHAR(66) NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "blockTimestamp" TIMESTAMP(3),
    "args" JSONB NOT NULL,
    "round" INTEGER,
    "amount" DECIMAL(78,0),
    "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chain_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "split_rounds" (
    "id" SERIAL NOT NULL,
    "splitId" INTEGER NOT NULL,
    "round" INTEGER NOT NULL,
    "joinCount" INTEGER NOT NULL DEFAULT 0,
    "fundedWei" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "finalized" BOOLEAN NOT NULL DEFAULT false,
    "finalizedAtBlock" INTEGER,
    "finalizedTx" VARCHAR(66),
    "totalDistributedWei" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "amountPerParticipantWei" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "finalizedParticipantCount" INTEGER NOT NULL DEFAULT 0,
    "remainderWei" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "firstBlock" INTEGER,
    "lastBlock" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "split_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "indexer_checkpoints" (
    "id" SERIAL NOT NULL,
    "chainId" INTEGER NOT NULL,
    "factoryId" INTEGER NOT NULL,
    "stream" VARCHAR(32) NOT NULL DEFAULT 'main',
    "lastIndexedBlock" INTEGER NOT NULL,
    "lastIndexedHash" VARCHAR(66),
    "lastSyncStartedAt" TIMESTAMP(3),
    "lastSyncCompletedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "eventsIndexed" INTEGER NOT NULL DEFAULT 0,
    "reorgCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "indexer_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "factories_chainId_address_key" ON "factories"("chainId", "address");

-- CreateIndex
CREATE INDEX "splits_factoryId_idx" ON "splits"("factoryId");

-- CreateIndex
CREATE UNIQUE INDEX "splits_chainId_address_key" ON "splits"("chainId", "address");

-- CreateIndex
CREATE INDEX "chain_events_chainId_blockNumber_idx" ON "chain_events"("chainId", "blockNumber");

-- CreateIndex
CREATE INDEX "chain_events_splitId_eventName_idx" ON "chain_events"("splitId", "eventName");

-- CreateIndex
CREATE INDEX "chain_events_splitId_round_idx" ON "chain_events"("splitId", "round");

-- CreateIndex
CREATE INDEX "chain_events_eventName_idx" ON "chain_events"("eventName");

-- CreateIndex
CREATE UNIQUE INDEX "chain_events_chainId_transactionHash_logIndex_key" ON "chain_events"("chainId", "transactionHash", "logIndex");

-- CreateIndex
CREATE INDEX "split_rounds_splitId_idx" ON "split_rounds"("splitId");

-- CreateIndex
CREATE UNIQUE INDEX "split_rounds_splitId_round_key" ON "split_rounds"("splitId", "round");

-- CreateIndex
CREATE UNIQUE INDEX "indexer_checkpoints_chainId_factoryId_stream_key" ON "indexer_checkpoints"("chainId", "factoryId", "stream");

-- AddForeignKey
ALTER TABLE "splits" ADD CONSTRAINT "splits_factoryId_fkey" FOREIGN KEY ("factoryId") REFERENCES "factories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chain_events" ADD CONSTRAINT "chain_events_splitId_fkey" FOREIGN KEY ("splitId") REFERENCES "splits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "split_rounds" ADD CONSTRAINT "split_rounds_splitId_fkey" FOREIGN KEY ("splitId") REFERENCES "splits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "indexer_checkpoints" ADD CONSTRAINT "indexer_checkpoints_factoryId_fkey" FOREIGN KEY ("factoryId") REFERENCES "factories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
