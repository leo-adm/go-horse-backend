import { numeric, pgTable, text } from "drizzle-orm/pg-core"

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  balance: numeric("balance", { precision: 10, scale: 2 })
    .notNull()
    .default("1000"),
})
