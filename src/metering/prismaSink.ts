import type { PrismaClient } from "@prisma/client";
import type { UsageRecord, UsageSink } from "./usageMeter.js";

export class PrismaUsageSink implements UsageSink {
  constructor(private readonly prisma: PrismaClient) {}

  async writeBatch(records: UsageRecord[]): Promise<void> {
    // createMany compiles to a single multi-row INSERT.
    await this.prisma.usageEvent.createMany({ data: records });
  }
}
