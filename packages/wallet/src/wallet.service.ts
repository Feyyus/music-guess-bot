import { Prisma, prisma, WalletTransaction } from "@feyyus/db";

type WalletTransactionClient = Parameters<
    Parameters<typeof prisma.$transaction>[0]
>[0];

export class InsufficientFundsError extends Error {
    constructor(message = "Insufficient funds") {
        super(message);
        this.name = "InsufficientFundsError";
    }
}

export class WalletService {
    constructor(private readonly database = prisma) {}

    async credit(
        userId: bigint,
        amount: number,
        reason: string,
        idempotencyKey: string,
    ): Promise<WalletTransaction> {
        if (amount <= 0) {
            throw new Error("Credit amount must be positive");
        }

        try {
            return await this.database.$transaction(
                async (tx: WalletTransactionClient) => {
                    const wallet = await tx.wallet.upsert({
                        where: { userId },
                        create: { userId, balance: 0 },
                        update: {},
                    });

                    const transaction = await tx.walletTransaction.create({
                        data: {
                            walletId: wallet.id,
                            amount,
                            reason,
                            relatedEntityId: null,
                            idempotencyKey,
                        },
                    });

                    await tx.wallet.update({
                        where: { id: wallet.id },
                        data: { balance: { increment: amount } },
                    });

                    return transaction;
                },
            );
        } catch (error: unknown) {
            if (error instanceof Prisma.PrismaClientKnownRequestError) {
                if (error.code === "P2002") {
                    return this.getExistingTransactionByIdempotencyKey(
                        idempotencyKey,
                    );
                }
            }
            throw error;
        }
    }

    async debit(
        userId: bigint,
        amount: number,
        reason: string,
        idempotencyKey: string,
    ): Promise<WalletTransaction> {
        if (amount <= 0) {
            throw new Error("Debit amount must be positive");
        }

        try {
            return await this.database.$transaction(
                async (tx: WalletTransactionClient) => {
                    const wallet = await tx.wallet.findUnique({
                        where: { userId },
                    });

                    if (!wallet || wallet.balance < amount) {
                        throw new InsufficientFundsError();
                    }

                    const transaction = await tx.walletTransaction.create({
                        data: {
                            walletId: wallet.id,
                            amount: -amount,
                            reason,
                            relatedEntityId: null,
                            idempotencyKey,
                        },
                    });

                    await tx.wallet.update({
                        where: { id: wallet.id },
                        data: { balance: { decrement: amount } },
                    });

                    return transaction;
                },
            );
        } catch (error: unknown) {
            if (error instanceof Prisma.PrismaClientKnownRequestError) {
                if (error.code === "P2002") {
                    return this.getExistingTransactionByIdempotencyKey(
                        idempotencyKey,
                    );
                }
            }
            throw error;
        }
    }

    async getBalance(userId: bigint): Promise<number> {
        const wallet = await this.database.wallet.findUnique({
            where: { userId },
        });
        return wallet?.balance ?? 0;
    }

    async getHistory(userId: bigint): Promise<WalletTransaction[]> {
        const wallet = await this.database.wallet.findUnique({
            where: { userId },
            include: { transactions: { orderBy: { createdAt: "desc" } } },
        });

        return wallet?.transactions ?? [];
    }

    private async getExistingTransactionByIdempotencyKey(
        idempotencyKey: string,
    ): Promise<WalletTransaction> {
        const existing = await this.database.walletTransaction.findUnique({
            where: { idempotencyKey },
        });

        if (!existing) {
            throw new Error(
                `No wallet transaction found for idempotency key: ${idempotencyKey}`,
            );
        }

        return existing;
    }
}
