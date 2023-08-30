---
title: Microsoft.Identity logs Errors without asking
date: 2023-08-30 20:22
prenote: This article was written based on `Microsoft.Identity.Web` v1.26.0.0.
---

`AddMicrosoftIdentityWebApi` from `Microsoft.Identity.Web` registers a bunch of services needed in authenticating incoming API requests with Azure AD. The choice of services is biased, and it turns out that the choice of log severity levels is also biased, which almost gave me false positive alerts in one of my projects. As of today, the severity is not configurable using options or configuration builders.

By default, if you invoke a request with a rubbish access token, there will be log entries created with `error` severity level out-of-box, which may not be what you want. For example:

`Microsoft.IdentityModel.LoggingExtensions.IdentityLoggerAdapter: Error: IDX10634: Unable to create the SignatureProvider.
Algorithm: 'HS256', SecurityKey: '[PII of type 'Microsoft.IdentityModel.Tokens.RsaSecurityKey' is hidden. For more details, see https://aka.ms/IdentityModel/PII.]' is not supported. The list of supported algorithms is available here: https://aka.ms/IdentityModel/supported-algorithms`

We could simply exclude the log category `Microsoft.IdentityModel.LoggingExtensions.IdentityLoggingAdapter`, but we may not want that either, because some of the errors may be true positives and not just bots hammering the API. We'd just prefer to decrease the severity to `warning`, but there does not seem to be a way to achieve that with the default dotnet logging features.

## Deep dive

`AddMicrosoftIdentityWebApi` invokes a private method `AddMicrosoftIdentityWebApiImplementation`, which invokes an util method `MicrosoftIdentityBaseAuthenticationBuilder.SetIdentityModelLogger(...)` in a `configureOptions` delegate:

```csharp
// Microsoft.Identity.Web.dll
namespace Microsoft.Identity.Web
{
    public static partial class MicrosoftIdentityWebApiAuthenticationBuilderExtensions
    {
        // ...
        private static void AddMicrosoftIdentityWebApiImplementation(
            AuthenticationBuilder builder,
            Action<JwtBearerOptions> configureJwtBearerOptions,
            Action<MicrosoftIdentityOptions> configureMicrosoftIdentityOptions,
            string jwtBearerScheme,
            bool subscribeToJwtBearerMiddlewareDiagnosticsEvents)
        {
            // ...
            builder.Services.AddOptions<JwtBearerOptions>(jwtBearerScheme)
                .Configure<IServiceProvider, IMergedOptionsStore, IOptionsMonitor<MicrosoftIdentityOptions>, IOptions<MicrosoftIdentityOptions>>((
                    options,
                    serviceProvider,
                    mergedOptionsMonitor,
                    msIdOptionsMonitor,
                    msIdOptions) =>
                {
                    // ...
                    MicrosoftIdentityBaseAuthenticationBuilder.SetIdentityModelLogger(serviceProvider);
                    // ...
                });
            // ...
        }
    }
}
```

This means that `MicrosoftIdentityBaseAuthenticationBuilder.SetIdentityModelLogger(...)` is called during runtime and not startup.

On the other hand, `MicrosoftIdentityBaseAuthenticationBuilder.SetIdentityModelLogger` looks like this:

```csharp
// Microsoft.Identity.Web.dll
namespace Microsoft.Identity.Web
{
    public abstract class MicrosoftIdentityBaseAuthenticationBuilder
    {
        // ...
        internal static void SetIdentityModelLogger(IServiceProvider serviceProvider)
        {
            if (serviceProvider != null)
            {
                // initialize logger only once
                if (LogHelper.Logger != NullIdentityModelLogger.Instance)
                    return;

                // check if an ILogger was already created by user
                ILogger? logger = serviceProvider.GetService<ILogger<IdentityLoggerAdapter>>();
                if (logger == null)
                {
                    var loggerFactory = serviceProvider.GetService<ILoggerFactory>();
                    if (loggerFactory != null)
                        logger = loggerFactory.CreateLogger<IdentityLoggerAdapter>();
                }

                // return if user hasn't configured any logging
                if (logger == null)
                    return;

                // initialize Wilson logger
                IIdentityLogger identityLogger = new IdentityLoggerAdapter(logger);
                LogHelper.Logger = identityLogger;
            }
        }
        // ...
    }
}
```

So they have clearly left us an escape hatch: To downgrade `System.Identity` log entries from `error` to `warning`, we can implement a custom `ILogger` and register it as singleton `ILogger<IdentityLoggerAdapter>`!

## Solution

We implement a logger that works otherwise exactly like the standard one, except that it should perform the downgrade. We can simply wrap an instance of the standard logger:

```csharp
// CustomIdentityLogger.cs
public class CustomIdentityLogger : ILogger<IdentityLoggerAdapter>
{
    private ILogger<IdentityLoggerAdapter> logger;

    public CustomIdentityLogger(ILoggerFactory loggerFactory)
    {
        logger = loggerFactory.CreateLogger<IdentityLoggerAdapter>();
    }

    public IDisposable BeginScope<TState>(TState state) => logger.BeginScope(state);

    public bool IsEnabled(LogLevel logLevel) => logger.IsEnabled(logLevel);

    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception exception, Func<TState, Exception, string> formatter)
    {
        if (logLevel == LogLevel.Error)
            logLevel = LogLevel.Warning;

        logger.Log(logLevel, eventId, state, exception, formatter);
    }
}
```

```csharp
// Program.cs
builder.Services.AddSingleton<ILogger<IdentityLoggerAdapter>, CustomIdentityLogger>();
```

And voilà, the severity is downgraded:

`Microsoft.IdentityModel.LoggingExtensions.IdentityLoggerAdapter: Warning: IDX10634: Unable to create the SignatureProvider.
Algorithm: 'HS256', SecurityKey: '[PII of type 'Microsoft.IdentityModel.Tokens.RsaSecurityKey' is hidden. For more details, see https://aka.ms/IdentityModel/PII.]' is not supported. The list of supported algorithms is available here: https://aka.ms/IdentityModel/supported-algorithms`
