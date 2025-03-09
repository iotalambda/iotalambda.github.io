---
title: Blazor with TypeScript Interop
date: 2025-03-09 16:00
prenote: You can find the full code for the example discussed here in its <a href="https://github.com/iotalambda/BlazorTsInteropExample">Github repo</a>. It's also running and available at <a href="https://food.joona.cloud/BlazorTsInteropExample">https://food.joona.cloud/BlazorTsInteropExample</a>.
---

Blazor has had support for JavaScript interop since [day one](https://learn.microsoft.com/en-us/aspnet/core/blazor/javascript-interoperability/?view=aspnetcore-3.1). It's fine and all, but it is still JavaScript and inherently dynamically typed. In this article, we have a look on one approach that allows us to use TypeScript instead. We use Vite to build distributable JavaScript modules from our TypeScript modules. In addition to having our types strong, we'd like to achieve some other quality-of-life improvements as well:

- The propagation of changes should be seamless between C#'s and TypeScript's type systems.
- TS type checking should be automatic whenever types change.
- Vite should build automatically whenever the Blazor app is built...
- ..but Vite should **NOT** build in case there are no relevant changes.
- The distributables built by Vite should be reloadable while the Blazor app is running by refreshing the page, not requiring a full restart. Hot-reload could be tricky, so let's not include that to our scope.

In this article we'll use Blazor WASM, but the approach works with Interactive Server as well.

## The approach

Ideally we'd like to have _adapters_ that we'd be able to invoke in our C# code, for example:

```razor
<!-- Home.razor -->

@inject BrowserConsoleAdapter BrowserConsole

<button onclick=@(() => BrowserConsole.LogAsync("Greetings!"))>
    Log greetings to browser console
</button>
```

The `BrowserConsoleAdapter` class should be _somehow_ mapped to a TypeScript module that would have a corresponding function to the `LogAsync` method:

```typescript
// browserConsoleAdapter.ts

async function logAsync(message: string) {
  console.log(message)
}

export default { logAsync } as IBrowserConsoleAdapter
```

If the signature of the `LogAsync` method changes, or methods are added to or removed from the `BrowserConsoleAdapter` class, then, when building the Blazor application, we'd get a build time error from TypeScript's type checking.

In the scenario above, click events originate from the `button` Blazor component and its `onclick` callback method simply invokes the `logAsync` TypeScript function over interop. But what if we'd also like to do the opposite: have an event listener instantiated in TypeScript which would invoke a C# handler method over interop? Let's say we'd like to listen for all click events and send information about their positions to a C# handler method `HandleClickAtAsync`:

```razor
<!-- Home.razor -->

<ol>
    @foreach (var (x, y) in clickPositions)
    {
        <li>Clicked at @x, @y.</li>
    }
</ol>

@code {
    List<(int X, int Y)> clickPositions = [];

    [JSInvokable]
    public Task HandleClickAtAsync(int x, int y)
    {
        clickPositions.Add((x, y));
        StateHasChanged();
        return Task.CompletedTask;
    }
}
```

We'd want to be able to register a TypeScript event listener that would invoke this method on click events. The invocation should still be strongly typed, so if the signature of the `HandleClickAtAsync` method changes, we'd like to see any type check errors at build time.

## `Reinforced.Typings`

There is an awesome .NET library for our type auto-generation needs: [`Reinforced.Typings`](https://github.com/reinforced/Reinforced.Typings). It allows us to have our C# types to be automatically turned into TypeScript types at build time by simply annotating the C# types with attributes like `TsInterfaceAttribute`, which specifically generates a TypeScript interface.

A skeleton of the `BrowserConsoleAdapter` class annotated with `Reinforced.Typings` attributes would look like this:

```csharp
// BrowserConsoleAdapter.cs

[TsInterface]
public class BrowserConsoleAdapter
{
    public async Task LogAsync(string message)
    {
        throw new NotImplementedException();
    }
}
```

In order to make the TypeScript type generation match our specific needs, we add the following three files to our C# project:

- `Reinforced.Typings.Assembly.cs`
- `ReinforcedTypingsConfiguration.cs`
- `Reinforced.Typings.settings.xml`.

### `Reinforced.Typings.Assembly.cs`

In this file we have just an assembly marker, which sets some necessary and nice-to-have preferences. We don't necessarily need an entire dedicated file for this, but I still added one for code organization purposes:

```csharp
// Reinforced.Typings.Assembly.cs

[assembly: Reinforced.Typings.Attributes.TsGlobal(
    UseModules = true,
    DiscardNamespacesWhenUsingModules = true,
    TabSymbol = "    ",
    CamelCaseForMethods = true,
    CamelCaseForProperties = true
)]
```

`UseModules = true` makes the auto-generated TypeScript interfaces to be exported from a module and thus importable to our TypeScript handler implementations. `DiscardNamespacesWhenUsingModules = true` omits generating the interfaces inside TypeScript namespaces. `TabSymbol = "    "` makes the auto-generated code use four tabs for indentation (adjust this as needed). `CamelCaseForMethods = true` and `CamelCaseForProperties = true` do exactly as they state: make auto-generated method and property names use camel casing instead of C# style pascal casing. Note that `CamelCaseForProperties = true` affects both parameter and return types (in case complex types are used).

### `ReinforcedTypingsConfiguration.cs`

In this file we set up a `ReinforcedTypingsConfiguration` class that is used for fine-tuning the default type generation logic:

```csharp
// ReinforcedTypingsConfiguration.cs

public static class ReinforcedTypingsConfiguration
{
    public static void Configure(Reinforced.Typings.Fluent.ConfigurationBuilder builder)
    {
        builder.Substitute(typeof(Task), new RtSimpleTypeName("Promise<void>"));
        builder.Substitute(typeof(Task<>), new RtSimpleTypeName("Promise"));
        builder.Substitute(typeof(Task<IJSObjectReference>), new RtSimpleTypeName("Promise<any>"));
        builder.SubstituteGeneric(typeof(DotNetObjectReference<>), (_, _) => new RtSimpleTypeName("DotNet.DotNetObject"));
    }
}
```

First we set up type substitution between generic and non-generic `Task`s (C#) and `Promise`s (TypeScript), which is not set by default.

We also set type substitution specifically from `Task<IJSObjectReference>` (C#) to `Promise<any>` (TypeScript). This is needed when a TypeScript handler returns a reference to a JavaScript object and we'd like to have access to that in a C# invoker.

Finally, we set up substitution from the generic `DotNetObjectReference` (C#) to the non-generic `DotNet.DotNetObject` (TypeScript). This is needed when we want to pass a reference – or really a handle – of a .NET object to a TypeScript handler, for example, when we want TypeScript to invoke some method of that .NET object. This type substitution instructs `Reinforced.Typings` to essentially not generate any corresponding TypeScript types for the C# types of the objects we want to pass as arguments. As is, this would reduce the type safety of our approach, because breaking changes to the signatures of the C# handler methods would not make TypeScript type checking fail. We'll need to address this later.

The `DotNet.DotNetObject` (TypeScript) type is exported by the [`@types/blazor__javascript-interop`](https://www.npmjs.com/package/@types/blazor__javascript-interop) package. It is used in the Vite project to provide corresponding TypeScript types of Blazor's built-in object reference types.

### `Reinforced.Typings.settings.xml`

This file contains a piece of MSBuild script that is imported to the C# project file each time the project is built:

```xml
<!-- Reinforced.Typings.settings.xml -->

<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="4.0" DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
    <PropertyGroup>
        <RtTargetFile>
            $(ProjectDir)Adapters\blazortsinteropexample\src\typings.ts
        </RtTargetFile>
        <RtConfigurationMethod>
            BlazorTsInteropExample.Stuff.ReinforcedTypings.ReinforcedTypingsConfiguration.Configure
        </RtConfigurationMethod>
    </PropertyGroup>
</Project>
```

With the `RtTargetFile` property, we instruct `Reinforced.Typings` to generate the types to the `typings.ts` file inside the `blazortsinteropexample` Vite project that contains our TypeScript code. We also instruct `Reinforced.Typings` to use the static `Configure` method of the `ReinforcedTypingsConfiguration` class we just implemented.

## Wiring the up the C# project

Before creating the `blazortsinteropexample` Vite project, let's set up our C# project in such a way that the type auto-generation and building the Vite project are part of the incremental MSBuild build process:

```xml
<!-- BlazorTsInteropExample.csproj -->

<Project Sdk="Microsoft.NET.Sdk.BlazorWebAssembly">

  <PropertyGroup>
    <RtSettingsXml>
        $([MSBuild]::EnsureTrailingSlash($(MSBuildProjectDirectory)))Stuff/ReinforcedTypings/Reinforced.Typings.settings.xml
    </RtSettingsXml>
  </PropertyGroup>

  <ItemGroup>
    <Folder Include="wwwroot\js\" />
  </ItemGroup>
  <Target Name="CompileTypeScript"></Target>

  <PropertyGroup>
    <ProjectDirWithTrailing>
        $([MSBuild]::EnsureTrailingSlash($(MSBuildProjectDirectory)))
    </ProjectDirWithTrailing>
  </PropertyGroup>
  <Target Name="RunNpmBuild" BeforeTargets="Build">
    <Exec Command="pwsh -File $(ProjectDirWithTrailing)Build/build_library.ps1 $(ProjectDirWithTrailing)" />
  </Target>

</Project>
```

First, we set a value for the `RtSettingsXml` property, so that `Reinforced.Typings` knows where to look for its settings at build time. We make sure that there are no extra slashes (or missing slashes) in the settings file's path by using the MSBuild utility function `EnsureTrailingSlash`.

We then explicitly include the `wwwroot\js\` folder to the project, so that the JavaScript distributables that that folder will contain would be part of the .NET publish.

We also replace the `CompileTypeScript` default MSBuild target with an empty one, so that MSBuild would not attempt to build the TypeScript files inside the Vite project as part of the build process.

Finally, we create a new MSBuild target called `RunNpmBuild`. This target runs the `build_library.ps1` script file using `pwsh` for cross-platform compatibility. `build_library.ps1` is responsible for the incremental build of the Vite project. So before the C# project is built, we want to check if the Vite project needs to be built as well, attempt to build it and finally have the JavaScript distributables to be put under the `wwwroot\js\` folder:

```powershell
# build_library.ps1

param(
    [string]$projectDirWithTrailing
)

$librarySourceDir = $projectDirWithTrailing + 'Adapters/blazortsinteropexample'
$npmBuildOutDir = $projectDirWithTrailing + 'wwwroot/js'

$npmBuildOutDirExists = Test-Path -Path $npmBuildOutDir
$npmBuildOutDirIsEmpty = if ($npmBuildOutDirExists) {
    (Get-ChildItem -Path $npmBuildOutDir -Recurse).Count -eq 0
} else {
    $true
}

if ($npmBuildOutDirIsEmpty) {
    Write-Host 'NpmBuildOutDir is empty. Running npm install...'
    cd $librarySourceDir
    npm install
    Write-Host 'Building the library...'
    npm run build
} else {
    $dateA = (Get-ChildItem -LiteralPath $librarySourceDir -File -Recurse |
        Where-Object { $_.FullName -notlike '*\node_modules\*' -and $_.Name -ne 'typings.ts' } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    ).LastWriteTime

    $dateB = (Get-ChildItem -LiteralPath $npmBuildOutDir -File -Recurse |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    ).LastWriteTime

    if ($dateA -gt $dateB) {
        Write-Host 'Library source files are newer than dist. Building the library...'
        cd $librarySourceDir
        npm run build
    }
}

```

So we simply check if:

- There are not yet any JavaScript distributables in the `wwwroot/js` directory
- OR if any of the files in the Vite project have more recent `LastWriteTime` compared to the current distributables.

And if either of these conditions is met, the Vite project is built. Note that we exclude the `typings.ts` file from the `LastWriteTime` comparison, because `Reinforced.Typings` can regenerate the file even when no actual changes have been made.

## Creating the Vite project

In order to create the Vite project, one should navigate to the desired directory, which in our case is `Adapters/` under the `.csproj` project directory, and run the following command:

```sh
npm create vite@latest
```

In our case the project name is `blazortsinteropexample` and we want to use just the vanilla Vite and the TypeScript variant.

Next, we install `@types/blazor__javascript-interop` as a dev dependency:

```sh
npm install --save-dev @types/blazor__javascript-interop
```

Finally, since we use Prettier for code formatting, we want to exclude the auto-generated `typings.ts` from its scope by adding a `.prettierignore` file under the Vite project with the following content:

```powershell
typings.ts
```

Assuming we added the earlier discussed `BrowserConsoleAdapter` skeleton to the C# project and we now run MSBuild, we should see the `typings.ts` file with the following content getting generated under the `src` directory of the Vite project:

```typescript
//     This code was generated by a Reinforced.Typings tool.
//     Changes to this file may cause incorrect behavior and will be lost if
//     the code is regenerated.

export interface IBrowserConsoleAdapter {
  logAsync(message: string): Promise<void>
}
```

Next, let's implement the `logAsync` TypeScript handler according to the approach that we planned earlier:

```typescript
// browserConsoleAdapter.ts

import { IBrowserConsoleAdapter } from "./typings"

async function logAsync(message: string) {
  console.log(message)
}

export default { logAsync } as IBrowserConsoleAdapter
```

Note that the last line `export default { logAsync } as IBrowserConsoleAdapter` binds everything together and gives us the security of strong types:

- If members are removed from or added to the `BrowserConsoleAdapter` C# class, equivalent changes **must** be made to the `browserConsoleAdapter.ts` module's default export, or otherwise the Vite build and thus the MSBuild will fail. 🎉
- If the signature of an existing member of the `BrowserConsoleAdapter` C# class change, equivalent changes **must** be made to the `browserConsoleAdapter.ts` module's default export, or otherwise the Vite build and thus the MSBuild will fail. 🎉

Finally, let's instruct Vite to generate a `browserConsoleAdapter.js` module from the `browserConsoleAdapter.ts` module during build and output it to the JavaScript distributables directory under `wwwroot/js`. Let's make the followind changes to the `vite.config.js` file:

```javascript
// vite.config.js

import { defineConfig } from "vite"

// https://vitejs.dev/config/
export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: "../../wwwroot/js/dist",
    lib: {
      entry: ["src/browserConsoleAdapter.ts"],
      formats: ["es"]
    }
  }
})
```

We instruct Vite to first clear the `wwwroot/js/dist` directory and then output the built JavaScript module of the `browserConsoleAdapter.ts` TypeScript module/entry point in the ESModule format. This way we can later import each module separately, either eagerly or lazily as needed.

## `BrowserConsoleAdapter` – from C# to TypeScript

Let's finalize the implementation of the `BrowserConsoleAdapter` class skeleton that we added earlier. In order to invoke the `logAsync` (TypeScript) function from the adapter, the adapter needs to make sure that the `browserConsoleAdapter.js` module has been imported. After that it can invoke the `logAsync` function that has been exported as part of the `default` object:

```csharp
// BrowserConsoleAdapter.cs

[TsInterface]
public class BrowserConsoleAdapter(IJSRuntime js)
{
    IJSObjectReference? module;

    public async Task LogAsync(string message, [TsIgnore] CancellationToken cancellationToken = default)
    {
        module ??= await ImportModule(cancellationToken);
        await module.InvokeVoidAsync("default.logAsync", cancellationToken, [message]);
    }

    [TsIgnore]
    async Task<IJSObjectReference> ImportModule(CancellationToken cancellationToken)
    {
        return await js.InvokeAsync<IJSObjectReference>("import", cancellationToken, "./js/dist/browserConsoleAdapter.js");
    }
}
```

We can inject `IJSRuntime` to the `BrowserConsoleAdapter` object and use it to import the `browserConsoleAdapter.js` module located under the `wwwroot/js/dist` directory. Note that we annotate the `ImportModule` method with `TsIgnoreAttribute` in order to exclude it from the `typings.ts` auto-generation. We also added a `CancellationToken` parameter to the `LogAsync` method, so that the import and the remote invocation over interop can be both cancelled gracefully if needed. We annotate it with `TsIgnoreAttribute` as well, because we don't want to pass `CancellationToken` objects as serialized JSON over interop. With `??=` we ensure that the module import is attempted only once in the scope of a single adapter object. When another adapter object is instantiated and the import is attempted again, the usual JavaScript module caching conventions of the user's browser are applied.

Let's add the `BrowserConsoleAdapter` class as a scoped service to the C# project's Dependency Injection container in the `Program.cs` file and let's use it to print greetings to the browser console:

```csharp
// Program.cs
builder.Services.AddScoped<BrowserConsoleAdapter>();
```

```razor
<!-- Home.razor -->

@inject BrowserConsoleAdapter BrowserConsole

<h1>C# → TypeScript</h1>
<button onclick=@(() => BrowserConsole.LogAsync("Greetings!"))>
    Log greetings to browser console
</button>
```

Now, if we build and launch the Blazor application, we should be able to see the `button` which prints greetings to the browser console when clicked.

## `PointerEventsAdapter` – from TypeScript to C#

Earlier we added the `HandleClickAtAsync` C# handler method to the `Home.razor` file. We'd like that to be invoked whenever a user clicks on the page. The TypeScript invoker must have access to a `DotNet.DotNetObject` (TypeScript) handle of the `Home` component object that we'd like to use for handling the invocation. While initializing the `Home` component, let's create a `DotNetObjectReference` (C#) handle that refers to the `Home` component object itself:

```razor
<!-- Home.razor -->

@inject PointerEventsAdapter PointerEvents

<h1>TypeScript → C#</h1>
<ol>
    @foreach (var (x, y) in clickPositions)
    {
        <li>Clicked at @x, @y.</li>
    }
</ol>

@code {

    DotNetObjectReference<Home>? selfReference;
    List<(int X, int Y)> clickPositions = [];

    protected override async Task OnInitializedAsync()
    {
        selfReference = DotNetObjectReference.Create(this);
        await PointerEvents.AddForHandlerAsync(selfReference, default);
    }

    [JSInvokable]
    public Task HandleClickAtAsync(int x, int y)
    {
        clickPositions.Add((x, y));
        StateHasChanged();
        return Task.CompletedTask;
    }
}
```

We also inject a `PointerEventsAdapter` object to the component and invoke its `AddForHandlerAsync` method. This method essentially passes the `DotNetObjectReference<Home>` (C#) handle from C# to TypeScript by invoking the `addForHandlerAsync` handler function of `pointerEventsAdapter.js`, a new JavaScript module that will be introduced in a moment:

```csharp
// PointerEventsAdapter.cs

[TsInterface]
public class PointerEventsAdapter(IJSRuntime js) : IAsyncDisposable
{
    IJSObjectReference? module;

    public async Task AddForHandlerAsync<THandler>(DotNetObjectReference<THandler> handlerReference, [TsIgnore] CancellationToken cancellationToken)
        where THandler : class, IPointerEventsAdapterHandler
    {
        module ??= await ImportModule(cancellationToken);
        await module.InvokeVoidAsync("default.addForHandlerAsync", cancellationToken, [handlerReference]);
    }

    [TsIgnore]
    async Task<IJSObjectReference> ImportModule(CancellationToken cancellationToken)
    {
        return await js.InvokeAsync<IJSObjectReference>("import", cancellationToken, "./js/dist/pointerEventsAdapter.js");
    }
}
```

Instead of requiring the passed `DotNetObjectReference` handle to strictly refer to a `Home` component object, we use a generic parameter `THandler` with an interface constraint. This way any class implementing the `IPointerEventsAdapterHandler` interface can be used to instantiate compatible C# handler objects. So let's also create the `IPointerEventsAdapterHandler` interface and make the `Home` component implement it:

```csharp
// IPointerEventsAdapterHandler.cs

[TsInterface]
public interface IPointerEventsAdapterHandler
{
    Task HandleClickAtAsync(int x, int y);
}
```

```razor
<!-- Home.razor -->

@implements IPointerEventsAdapterHandler
@inject PointerEventsAdapter PointerEvents
```

Note that the `HandleClickAtAsync` signature can't have a `CancellationToken` parameter because, in this case, invocations originate from TypeScript and the concept of `CancellationToken` doesn't exist there.

While we're at it, let's register the `PointerEventsAdapter` class as a scoped service in the `Program.cs` file:

```csharp
// Program.cs

builder.Services.AddScoped<PointerEventsAdapter>();
```

Now, when the C# project is built, new auto-generated types will get added the `typings.ts` file:

```typescript
export interface IPointerEventsAdapterHandler {
  handleClickAtAsync(x: number, y: number): Promise<void>
}
export interface IPointerEventsAdapter {
  addForHandlerAsync<THandler>(handlerReference: DotNet.DotNetObject): Promise<void>
}
```

We can now implement the `pointerEventsAdapter` (TypeScript) handler module, that should export the `addForHandlerAsync` handler function. A naïve implementation of the handler would look like this:

```typescript
// pointerEventsAdapter.ts

let handlerRef: DotNet.DotNetObject

async function addForHandlerAsync(handlerReference: DotNet.DotNetObject) {
  handlerRef = handlerReference
  window.addEventListener("click", ev => {
    handlerRef.invokeMethodAsync("HandleClickAtAsync", ev.x, ev.y)
  })
}

export default { addForHandlerAsync } as IPointerEventsAdapter
```

With the naïve implementation, the invocation of the `HandleClickAtAsync` (C#) handler method would not utilize any of our auto-generated interfaces and would be fully dynamically typed. Instead of this, let's create an `invokeHandler` utility TypeScript function that makes sure that all C# handler method invocations from TypeScript are covered by TypeScript type checking:

```typescript
// utils.ts

type ExtractParams<T, K extends keyof T & string> = T[K] extends (...args: infer P) => any ? P : never
type ExtractReturn<T, K extends keyof T & string> = T[K] extends (...args: any[]) => Promise<infer R> ? R : never

export async function invokeHandler<THandler>(
  handlerRef: DotNet.DotNetObject,
  member: keyof THandler & string,
  ...args: ExtractParams<THandler, keyof THandler & string>
): Promise<ExtractReturn<THandler, keyof THandler & string>> {
  const methodName = member.charAt(0).toUpperCase() + member.slice(1)
  return handlerRef.invokeMethodAsync(methodName, ...args)
}
```

By passing an auto-generated interface as an argument to the generic parameter `THandler`, `invokeHandler` makes sure that the C# handler method we are attempting to invoke is one of the members of the interface AND that the passed parameters and the return type match the member's signature 🎉. So our final implementation of the `pointerEventsAdapter` (TypeScript) handler looks like this:

```typescript
// pointerEventsAdapter.ts

let handlerRef: DotNet.DotNetObject

async function addForHandlerAsync(handlerReference: DotNet.DotNetObject) {
  handlerRef = handlerReference
  window.addEventListener("click", ev => {
    invokeHandler<IPointerEventsAdapterHandler>(handlerRef, "handleClickAtAsync", ev.x, ev.y)
  })
}

export default { addForHandlerAsync } as IPointerEventsAdapter
```

Note that we store the `handlerReference` argument to the `handlerRef` variable simply so that other TypeScript handler functions added to the `pointerEventsAdapter` handler can reuse it. Though, in our example implementation it's not strictly required.

Finally, let's add the `pointerEventsAdapter.ts` file as a new entry point to `vite.config.js`, so that Vite will build the `pointerEventsAdapter.js` module:

```javascript
// vite.config.js

import { defineConfig } from "vite"

// https://vitejs.dev/config/
export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: "../../wwwroot/js/dist",
    lib: {
      entry: ["src/browserConsoleAdapter.ts", "src/pointerEventsAdapter.ts"],
      formats: ["es"]
    }
  }
})
```

Now, if we build and launch the Blazor application, we should be able to see new entries appearing to the list shown on the page each time we click somewhere.

## Evaluation

The goals we set in the introduction of this article were met relatively well:

- Type changes in C# are automatically propagated to TypeScript by `Reinforced.Typings`. ✅
- We fully leverage TypeScript's type checking capabilities and type mismatches are automatically detected as part of the Blazor app's MSBuild process. ✅
- The Vite project gets automatically built whenever it's necessary – and doesn't when it's not – as part of the Blazor app's MSBuild process. ✅
- JavaScript modules can be re-imported during a Blazor debug session by simply refreshing the page. We can even have Vite watching for changes in files in the Vite project and automatically rebuild the distributables by using the `npm watch` command. `npm watch` can run in parallel with a Blazor debug session. ✅

Naturally, the standard limitations of the Blazor JavaScript interop haven't gone anywhere. For example, our TypeScript handlers don't really understand C# object references, except for what limited support `DotNet.DotNetObject` handles provide. All communication still uses simple JSON serialization.

Also, the caveats of TypeScript duck-typing apply. As an example, if we removed the `message` parameter of the `logAsync` function from the `browserConsoleAdapter` (TypeScript) module, `logAsync` would still be compliant with the auto-generated `IBrowserConsoleAdapter` (TypeScript) interface, thanks to duck-typing. But, on the other hand, changing the `message` parameter's type or adding more parameters to the `logAsync` function, when not implementing corresponding changes to the `BrowserConsoleAdapter` (C#) class, would be caught.
