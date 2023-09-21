---
title: EF Core authentication with DefaultAzureCredential
date: 2023-09-21 21:00
prenote: This article was written based on Microsoft.EntityFrameworkCore 7.0.10.0 and Visual Studio 2022 17.6.6.
---

If you use Azure and don't wish to bake any secrets into your appsettings file, you should use `DefaultAzureCredential`. You can simply new up an `DefaultAzureCredential` instance and start requesting access tokens. The nicest part is that it is context aware:

- **In Visual Studio**, when developing things locally, your Visual Studio account is used
- **In Azure**, the local identity, such as Managed Identity is used.

This means that you can fully leverage Azure AD in accessing your cloud resources and take a big leap towards [a zero-trust architecture](https://en.wikipedia.org/wiki/Zero_trust_security_model).

At the moment, EF Core does not provide a straight-forward way to use `DefaultAzureCredential` for authentication, which is a problem. There are some workarounds, such as [hacking the `DbContext`](https://stackoverflow.com/q/54187241) which is not nice, and [adding interceptors](https://stackoverflow.com/a/63820411) which I haven't had much luck with. [The official Microsoft recommendation](https://learn.microsoft.com/en-us/azure/azure-sql/database/azure-sql-dotnet-entity-framework-core-quickstart?view=azuresql&tabs=visual-studio%2Cservice-connector%2Cportal#add-the-code-to-connect-to-azure-sql-database) is to simply use `Authentication=Active Directory Default` in the connection string, but this can also be tricky if your account belongs to different tenants: there is no way to select the Azure tenant, so Visual Studio will probably just pick "the first one in the list".

## Custom SQL authentication provider

In .NET, there is a way to _overwrite `SqlAuthenticationProviders`_. You can create your own provider that uses `DefaultAzureCredentials` internally and makes sure that the desired tenant is selected:

```csharp
public class CustomActiveDirectoryDefaultAuthenticationProvider : SqlAuthenticationProvider
{
    private readonly string tenantId;

    public CustomActiveDirectoryDefaultAuthenticationProvider(string tenantId)
    {
        this.tenantId = tenantId;
    }

    public override async Task<SqlAuthenticationToken> AcquireTokenAsync(SqlAuthenticationParameters parameters)
    {
        var context = new TokenRequestContext(new[] { "https://database.windows.net//.default" });
        var options = new DefaultAzureCredentialOptions
        {
            VisualStudioTenantId = tenantId,
            ExcludeInteractiveBrowserCredential = true,
            ExcludeAzureCliCredential = true,
            ExcludeAzurePowerShellCredential = true,
            ExcludeEnvironmentCredential = true,
            ExcludeManagedIdentityCredential = false,
            ExcludeSharedTokenCacheCredential = true,
            ExcludeVisualStudioCodeCredential = true,
            ExcludeVisualStudioCredential = false
        };
        var token = await new DefaultAzureCredential(options).GetTokenAsync(context);
        return new SqlAuthenticationToken(token.Token, token.ExpiresOn);
    }

    public override bool IsSupported(SqlAuthenticationMethod authenticationMethod)
        => authenticationMethod.Equals(SqlAuthenticationMethod.ActiveDirectoryDefault);
}
```

The key point is that now we can provide a value for `VisualStudioTenantId`.

Please notice that all other methods except for Visual Studio Credential based authentication are excluded. This is because `DefaultAzureCredential` iterates over and attempts each authentication method. If one fails it will try the next one (unless excluded), which can take a moment and slow down your inner loop. By excluding all unnecessary methods, this problem is avoided.

You can register this provider in your application's DI:

```csharp
SqlAuthenticationProvider.SetProvider(
    SqlAuthenticationMethod.ActiveDirectoryDefault,
    new CustomActiveDirectoryDefaultAuthenticationProvider(myAzureTenantId));
```

And now the default `ActiveDirectoryDefault` authentication method is **overwritten** with your custom one! You can also register your `DbContext` with SQL Server (or Azure SQL) provider as usual:

```csharp
services.AddDbContext<MyDbContext>(o =>
    o.UseSqlServer("server=tcp:my-azure-sql.database.windows.net,1433;database=myDb;Authentication=Active Directory Default;Connection Timeout=60"));
```

And, as long as you have _configured Azure Service Authentication in Visual Studio_, you now have access to the database using your Visual Studio credentials in Visual Studio and a Managed Identity in Azure.

I'd also recommend to set a `Connection Timeout` that is big enough to withstand the time that it takes to fetch a token when you don't have a fresh one in your cache. Usually it's fast, but at times it can take a while.

## **BONUS**: Setting up and troubleshooting Azure Service Authentication in Visual Studio

Set up the authentication by hitting `CTRL`+`Q` and searching "Azure Service Authentication". Select your account from the dropdown. Sometimes the dropdown doesn't work and it can also crash Visual Studio, so it may or may not take couple of attempts.

If your token has expired, you need to open up the "Azure Service Authentication" window again and re-enter your credentials. Sometimes you also need to restart Visual Studio after this.

If you seem to be able to enter your credentials, but you have an authentication problem that persists, it could be due to your cached token being invalid one way or another. For example, the token was received without MFA but your desired tenant requires MFA. One way to _really_ refresh the token on-demand is to use _System web browser_ and remove token from the login page's local storage. Hit `CTRL`+`Q` and search for "sign-in" and choose "System web browser" from the dropdown. If you now try to go re-enter your credentials, the login screen is opened in your default browser.
