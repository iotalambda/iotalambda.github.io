---
title: Multitenant Azure Functions
date: 2020-12-27 10:00:00
categories: azure
---

Azure Function runtime provides a smorgasbord of features out-of-box. One of those features isn´t <i>multitenancy</i> (except when talking about clients using Azure AD) but one of those features is <i>Function keys</i>. In this blog post I explore how tenant specific Function keys could be used to enable multitenancy in simple scenarios. Ideally introducing a new tenant - assuming that no customization is required - should be only a question of creating a Function key for said tenant. _Disclaimer:_ In many cases using Function keys is not a sufficient authentication method, and OAuth2 or mutual-auth or at least API Key auth with Azure Vault stored keys should be used instead.

## A new ⚡

Here´s a plain Function with an HTTP trigger. For every incoming `POST host.com/enqueueV1/{tenantId}?code={keyValue}` request, it enqueues the incoming request body content as string to a tenant specific `{tenantId}` queue.

```csharp
[StorageAccount("AzureWebJobsStorage")]
public static class EnqueueForTenantV1
{
  [FunctionName("EnqueueForTenantV1")]
  [return: Queue("{tenantId}")]
  public static Task<string> Run(
    [HttpTrigger(AuthorizationLevel.Function, "POST", Route = "enqueueV1/{tenantId}")] HttpRequest req
  )
  {
    using var reader = new StreamReader(req.Body);
    return reader.ReadToEndAsync();
  }
}
```

Now, let´s say that there are two Function keys for this Function. Each key belongs to a unique tenant. We use `tenantId`s as `keyId`s:

```
Tenant    | keyId     | keyValue
----------+-----------+----------
Microsoft | microsoft | bill123
Apple     | apple     | jobs456
```

As an example, `EnqueueForTenantV1` allows Apple to do requests like `POST host.com/enqueueV1/apple?code=jobs456`. The only problem is that the current Function implementation <i>does not forbid access to other tenants´ resources:</i> Apple could also do a request like `POST host.com/enqueueV1/microsoft?code=jobs456`. Now this is less than optimal 🤔

## Checking what is claimed

Azure Function runtime includes the `keyId` of the used key [as a claim](https://stackoverflow.com/a/62387169/10212522). We could just bind the `tenantId` whose resources are attempted to be accessed and compare that to the claim directly in the function body:

```csharp
[StorageAccount("AzureWebJobsStorage")]
public static class EnqueueForTenantV2
{
  [FunctionName("EnqueueForTenantV2")]
  [return: Queue("{tenantId}")]
  public static Task<string> Run(
    [HttpTrigger(AuthorizationLevel.Function, "POST", Route = "enqueueV2/{tenantId}")] HttpRequest req,
    string tenantId
  )
  {
    var actualTenantId = req.HttpContext.User.Identities.Single().FindFirst("http://schemas.microsoft.com/2017/07/functions/claims/keyid").value;

    // Check if attempted tenant id matches the actual tenant id
    if (tenantId != actualTenantId)
      return new UnauthorizedResult();

    using var reader = new StreamReader(req.Body);
    return reader.ReadToEndAsync();
  }
}
```

but this is not very reusable. Preferably all of this would be checked with an attribute of some sort.

## Filters for Functions

Similar to `ActionFilter`s in ASP.NET Core, Azure Functions have (currently a preview feature called) `FunctionInvocationFilter`s. We can create one of our own for tenant authorization purposes and move the aforementioned logic over there:

```csharp
public class AuthorizeTenantAttribute : FunctionInvocationFilterAttribute
{
  public override Task OnExecutingAsync(FunctionExecutingContext executingContext, CancellationToken cancellationToken)
  {
    var (attemptedTenantId, actualTenantId) = GetTenantIdsSomehow();

    // Check if attempted tenant id matches the actual tenant id
    if (attemptedTenantId != actualTenantId)
      throw new UnauthorizedAccessException();

    return base.OnExecutingAsync(executingContext, cancellationContext);
  }
}
```

and thus our Function can be reduced to

```csharp
[StorageAccount("AzureWebJobsStorage")]
public static class EnqueueForTenantV2
{
  [FunctionName("EnqueueForTenantV2")]
  [return: Queue("{tenantId}")]
  [AuthorizeTenant]
  public static Task<string> Run(
    [HttpTrigger(AuthorizationLevel.Function, "POST", Route = "enqueueV2/{tenantId}")] HttpRequest req
  )
  {
    using var reader = new StreamReader(req.Body);
    return reader.ReadToEndAsync();
  }
}
```

Unluckily, `OnExecutingAsync` returns just a `Task` and there seems to be no way to access `HttpContext` and set response´s `StatusCode` inside a `FunctionInvocationFilterAttribute`. This problem may be due to `FunctionInvocationFilterAttribute`s being still only a preview feature, but at the same time they have been in preview already for three years, and [Microsoft does not <i>seem</i> to be commited to develop this feature any further](https://github.com/Azure/azure-webjobs-sdk/issues/1284). Therefore, at least for the time being, the Function will return just `HTTP 500` in case the attempted and actual `tenantId`s did not match (due to uncaught `UnauthorizedAccessException` being thrown in such a scenario).

Another problem is that we should be able to `GetTenantIdsSomehow`. This, on the contrary, is resolvable 🙂

## Getting `tenantId`s somehow

`AuthorizeTenantAttribute`´s `OnExecutingAsync` has this `FunctionExecutingContext executingContext` parameter which can be used to access the arguments that `EnqueueForTenantV2` was invoked with. Therefore, we need to create a <i>custom binding</i> that does all the heavylifting regarding the extraction of `tenantId`s and then just provides them to `AuthorizeTenantAttribute` via `FunctionExecutingContext executingContext`.

In order to bind our desired values to a Function parameter, we need a new <i>parameter</i> for the Function and a <i>binding</i> that sets the parameter value. Off the top of our heads, let´s jut decide that

- the parameter type is `TenantContext`, which holds all information related to the tenant that´s currently invoking the Function and
- the binding type is `Tenancy`.

Now our Function signature looks like this

```csharp
...
  [FunctionName("EnqueueForTenantV2")]
  [return: Queue("{tenantId}")]
  [AuthorizeTenant]
  public static Task<string> Run(
    [HttpTrigger(AuthorizationLevel.Function, "POST", Route = "enqueueV2/{tenantId}")] HttpRequest req,
    [Tenancy("{tenantId}")] TenantContext _
  )
  {
...
```

`Tenancy` has a single constructor parameter that should be set as [the binding expression](https://docs.microsoft.com/en-us/azure/azure-functions/functions-bindings-expressions-patterns) for attempted `tenantId`, because it can be very situational (Function specific) how it should be extracted from a request. In `EnqueueForTenantV2`´s case, the attempted `tenantId` is extracted from the queue name that is attempted to be accessed, so the binding expression is `{tenantId}`.

`TenantContext` parameter is just discarded with `_`, because it is not really needed in the Function body. It is just required to be bound and accessible by `AuthorizeTenantAttribute`. `TenantContext`´s implementation should be just a lookup POCO:

```csharp
public class TenantContext
{
  public TenantContext(string attemptedTenantId, string actualTenantId)
  {
    AttemptedTenantId = attemptedTenantId;
    ActualTenantId = actualTenantId;
  }

  public string AttemptedTenantId { get; }

  public string ActualTenantId { get; }
}
```

Now we can get `TenantContext` and `tenantId`s in our Function filter:

```csharp
public class AuthorizeTenantAttribute : FunctionInvocationFilterAttribute
{
  public override Task OnExecutingAsync(FunctionExecutingContext executingContext, CancellationToken cancellationToken)
  {
    var tenantContext = executingContext.Arguments.Single(i => i.Value is TenantContext).Value;
    var attemptedTenantId = tenantContext.AttemptedTenantId;
    var actualTenantId = tenantContext.ActualTenantId;

    // Check if attempted tenant id matches the actual tenant id
    if (attemptedTenantId != actualTenantId)
      throw new UnauthorizedAccessException();

    return base.OnExecutingAsync(executingContext, cancellationContext);
  }
}
```

The last piece to the puzzle is to implement the custom `Tenancy` binding that brings `TenantContext` available for `AuthorizeTenantAttribute`.

## The Binding

`Tenancy` binding is essentially `TenancyAttribute` with parameter usage allowed. It should have a constructor with a parameter for a binding expression for the <i>attempted `tenantId`</i> as was discussed:

```csharp
[Binding]
[AttributeUsage(AttributeTargets.Parameter)]
public class TenancyAttribute : Attribute
{
  public TenancyAttribute(string attemptedTenantId)
  {
    AttemptedTenantId = attemptedTenantId;
  }

  [AutoResolve(ResolutionPolicyType = typeof(AttemptedTenantKeyResolutionPolicy))]
  public string AttemptedTenantId { get; set; }

// To be continued...
...

```

In Azure Functions, the values for properties of bound object can be <i>auto-resolved</i> using `IResolutionPolicy`s. For example, the value for `AttemptedTenantId` is auto-resolved using `AttemptedTenantIdResolutionPolicy`:

```csharp
public class AttemptedTenantIdResolutionPolicy : IResolutionPolicy
{
  public string TemplateBind(PropertyInfo propInfo, Attribute resolvedAttribute, BindingTemplate bindingTemplate, IReadOnlyDictionary<string, object> bindingData)
  {
    var attemptedTenantId = bindingData[bindingTemplate.ParameterNames.Single()] as string;
    return attemptedTenantId;
  }
}
```

`bindingData` contains all key-values that have been resolved so far (including the value for the attempted `tenantId`, e.g. key-value `"tenantId" => "microsoft"`).

On the other hand, `bindingTemplate.ParameterNames` contains an `IEnumerable` of the binding expression parameter names associated with the property upon which this `AttemptedTenantIdResolutionPolicy` is used. In case of `TenancyAttribute`´s `AttemptedTenantId`, `bindingTemplate.ParameterNames` contains only the parameter names in the binding expression that the property has as its value. The property has `"{tenantId}"`as its value, meaning that the binding expression contains only one parameter name: `"tenantId"`. Therefore `TemplateBind` will return the attempted `tenantId` in the requested path, e.g. `"microsoft"`.

## The plot thickens

As required by `AuthorizeTenantAttribute`, we also need to have the <i>actual `tenantId`</i> in `TenantContext`. Therefore `TenantContext` should be like

```csharp
[Binding]
[AttributeUsage(AttributeTargets.Parameter)]
public class TenancyAttribute : Attribute
{
  public TenancyAttribute(string attemptedTenantId)
  {
    AttemptedTenantId = attemptedTenantId;
  }

  [AutoResolve(ResolutionPolicyType = typeof(AttemptedTenantIdResolutionPolicy))]
  public string AttemptedTenantId { get; set; }

  [AutoResolve(ResolutionPolicyType = typeof(ActualTenantIdResolutionPolicy))]
  public string ActualTenantId { get; set; } = "{sys.MethodName}";

}
```

...and this contains a <i>slight</i> hack: As discussed, `ActualTenantId` should be actually extracted from the `keyid` claim, but the binding expression system of Azure Functions does not support claims (which would be such a good feature). If we left `ActualTenantId` as `null`, then `ActualTenantIdResolutionPolicy` would never be invoked and `ActualTenantId` would be left `null`! To make `ActualTenantIdResolutionPolicy` to be executed, we initialize the property with value `{sys.MethodName}`. This is just a placeholder and any binding expression could be used instead.

Anyway, `ActualTenantIdResolutionPolicy` just receives the `HttpRequest` from `bindingData` (Azure Functions runtime always binds `HttpRequest` using the key `$request` even when it´s not part of the Function signature), gets the actual `tenantId` from the claim and returns it:

```csharp
public class ActualTenantIdResolutionPolicy : IResolutionPolicy
{
  public string TemplateBind(PropertyInfo propInfo, Attribute resolvedAttribute, BindingTemplate bindingTemplate, IReadOnlyDictionary<string, object> bindingData)
  {
    var req = bindingData["$request"] as HttpRequest;
    var actualTenantId = req.HttpContext.User.Identities.Single().FindFirst("http://schemas.microsoft.com/2017/07/functions/claims/keyid").value;
    return actualTenantId;
  }
}
```

## Implementation details

To make Azure Functions aware of the binding and how `TenantContext` properties should actually be populated, we need a bit of extra wiring. We have to implement a `TenantContextExtension` that we can register in `Startup.Configure` and which actually maps the bound `TenancyAttribute` properties to `TenantContext` using a `BindingRule`:

```csharp
[Extension(nameof(TenantContextExtension))]
public class TenantContextExtension : IExtensionConfigProvider
{
  public void Initialize(ExtensionConfigContext context)
  {
    var rule = context.AddBindingRule<TenancyAttribute>();
    rule.BindToInput(tenancy => new TenantContext(tenancy.AttemptedTenantId, tenancy.ActualTenantId));
  }
}
```

Then in `Startup.Configure` we do:

```csharp
public class Startup : IWebJobsStartup
{
  public void Configure(IWebJobsBuilder builder)
  {
    builder.AddExtension<TenantContextExtension>();
  }
}
```

And there we have it! Now Apple and Microsoft can no more enqueue to each other´s queues. If the attempted and actual `tenantId`s do not match, `AuthorizeTenantAttribute` will throw an exception and the request will be terminated before the Function is invoked.

## The Hindsight

Considering that HTTP triggers are the only triggers that external parties would invoke directly, the discussed method should at least trigger-wise be a sufficient solution for Azure Functions multitenancy in scenarios when the Function key system is wanted to be "abused" for both authorization and multitenancy. For example, blob triggers are invoked only indirectly, as <i>either</i> the tenant has no access to the source Storage container <i>or</i> it has a SAS key to that tenant specific container.

Even from the infrastructure point of view, introducing new tenants should really be just a matter of creating and sharing new Function keys. If, for example, a tenant specific queue is missing when `EnqueueForTenantV2` is invoked, then Azure Function runtime will create the queue. The same will occur also with containers. Thus the infrastructure should - at least for the most part - <i>emerge on demand</i>.

One can also choose a strategy for the tenant keys, as Function keys can allow either <i>Function level</i> or <i>Host level</i> access. If one does not want to provide tenants access to each function separately, then one should use Host keys instead.

In the end this was just an experimentation and is not recommended for production use, because Function keys are not as safe mean of authorization as, for example, OAuth2 or mutual certificate authentication.
