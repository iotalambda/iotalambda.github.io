---
title: Type-safe Database Views with EF
date: 2025-07-03 16:00
prenote: You can find the full code for the example discussed here in its <a href="https://github.com/iotalambda/EFCodeFirstCreateView">Github repo</a>.
---

At times, it can be beneficial to have a stable, normalized view into the data in your database tables. For example, if you wish to synchronize your transaction data periodically to a reporting system, like Power BI, you might want to provide the synchronization process with limited but stable read access to your data. The simplest way to achieve this is **views**. Nowadays, views don't tend to get a lot of love, but this use case is definitely one where views still come in handy.

You can naturally manufacture and manage views completely manually, but this leaves room for DB migrations in the underlying tables attempting to make contradicting changes, and thus either the migrations fail or the views are left in a broken state. In the .NET world, Entity Framework is great for managing your tables code-first and running migrations, but it doesn't support views out-of-box. Luckily, it's not too hard to implement basic support for having managed views as well. EF has the awesome capability to translate .NET expressions to SQL, and we can leverage this capability.

Let's say we have a `DbContext` with the following entities: `Order`s, `OrderRow`s and `Product`s, and we'd like to create a view that displays `OrderProduct`s with total prices of each ordered product of each order. The query would look something like this:

```c#
from o in ctx.Orders
join or in ctx.OrderRows on o.Id equals or.OrderId
join p in ctx.Products on or.ProductId equals p.Id
select new OrderProduct
{
    OrderNumber = o.OrderNumber,
    EAN = or.Product!.EAN,
    Amount = or.Amount,
    TotalPriceEur = or.Amount * or.Product.PriceEur
}
```

We can get the raw SQL of this query using `ToQueryString`:

```c#
var orderProductsQuerySql =
    (from o in ctx.Orders
     join or in ctx.OrderRows on o.Id equals or.OrderId
     join p in ctx.Products on or.ProductId equals p.Id
     select new OrderProduct
     {
         OrderNumber = o.OrderNumber,
         EAN = or.Product!.EAN,
         Amount = or.Amount,
         TotalPriceEur = or.Amount * or.Product.PriceEur
     }).ToQueryString();
```

Then we can simply create the view using `ExecuteSqlRaw` and the SQL dialect of the RDBMS of our choice:

```c#
ctx.Database.ExecuteSqlRaw($"CREATE VIEW vwOrderProducts AS {orderProductsQuerySql}");
```

Finally, we can test that the view works as it should:

```c#
var orderProducts = ctx.Database.SqlQueryRaw<OrderProduct>("SELECT * FROM vwOrderProducts");
```

And thus, we've created a view whose schema and query logic are guaranteed by the C# type system.
