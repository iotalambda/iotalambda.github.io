---
title: Blazor with TypeScript Interop
date: 2025-03-09 16:00
prenote: You can find the full code for the example discussed here in its <a href="https://github.com/iotalambda/BlazorTsInteropExample">Github repo</a>. It's also running and available at <a href="https://food.joona.cloud/BlazorTsInteropExample">https://food.joona.cloud/BlazorTsInteropExample</a>.
---

Blazor has supported JavaScript interop since [day one](https://learn.microsoft.com/en-us/aspnet/core/blazor/javascript-interoperability/?view=aspnetcore-3.1). It's fine and all, but it's still JavaScript and inherently dynamically typed. In this article, we take a look at one approach that allows us to use TypeScript instead. We use Vite to build distributable JavaScript modules from our TypeScript modules. In addition to having strong types, we aim to achieve some other quality-of-life improvements as well:

- Changes should propagate seamlessly between C#'s and TypeScript's type systems.
- TypeScript type checking should be automatic whenever types change.
- Vite should build automatically whenever the Blazor app is built...
- ...but **should NOT** build if there are no relevant changes.
- The distributables built by Vite should be reloadable while the Blazor app is running by simply refreshing the page, without requiring a full restart. Hot-reload could be tricky, so let's keep it out of scope.

In this article, we'll use Blazor WASM, but the approach also works with Interactive Server.

## The approach

Ideally, we'd like to have _adapters_ that we can invoke in our C# code, for example:

```razor
<!-- Home.razor -->

@inject BrowserConsoleAdapter BrowserConsole

<button onclick=@(() => BrowserConsole.LogAsync("Greetings!"))>
    Log greetings to browser console
</button>
```

The `BrowserConsoleAdapter` class should be _somehow_ mapped to a TypeScript module that includes a corresponding function for the `LogAsync` method:

```typescript
// browserConsoleAdapter.ts

async function logAsync(message: string) {
  console.log(message)
}

export default { logAsync } as IBrowserConsoleAdapter
```

If the signature of the `LogAsync` method changes, or if methods are added or removed from the `BrowserConsoleAdapter` class, then when building the Blazor application, we would get a build-time error from TypeScript's type checking.

In the scenario above, click events originate from the `button` Blazor component, and its `onclick` callback method simply invokes the `logAsync` TypeScript function over interop. But what if we also wanted to do the opposite: have an event listener instantiated in TypeScript that invokes a C# handler method over interop?

Let's say we want to listen for all click events and send information about their positions to a C# handler method, `HandleClickAtAsync`:

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

We want to be able to register a TypeScript event listener that invokes this method on click events. The invocation should still be strongly typed, so if the signature of the `HandleClickAtAsync` method changes, we should see type check errors at build time.

## `Reinforced.Typings`

There is an awesome .NET library for our type auto-generation needs: [`Reinforced.Typings`](https://github.com/reinforced/Reinforced.Typings). It allows us to automatically convert C# types into TypeScript types at build time by simply annotating the C# types with attributes like `TsInterfaceAttribute`, which specifically generates a TypeScript interface.

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

This file contains just an assembly marker, which sets some necessary and nice-to-have preferences. We don't necessarily need an entire dedicated file for this, but I still added one for code organization purposes:

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

First, we set up type substitution between generic and non-generic `Task`s (C#) and `Promise`s (TypeScript), which is not configured by default.

We also configure type substitution specifically from `Task<IJSObjectReference>` (C#) to `Promise<any>` (TypeScript). This is necessary when a TypeScript handler returns a reference to a JavaScript object, and we want to access it in a C# invoker.

Finally, we set up substitution from the generic `DotNetObjectReference` (C#) to the non-generic `DotNet.DotNetObject` (TypeScript). This is required when passing a reference — or more accurately, a handle — of a .NET object to a TypeScript handler, for example when we want TypeScript to invoke a method on that .NET object. This type substitution instructs `Reinforced.Typings` to avoid generating corresponding TypeScript types for the C# types of the objects we pass as arguments. As such, this would reduce type safety because breaking changes to the signatures of the C# handler methods would not cause TypeScript type checking to fail. We'll need to address this later.

The `DotNet.DotNetObject` (TypeScript) type is exported by the [`@types/blazor__javascript-interop`](https://www.npmjs.com/package/@types/blazor__javascript-interop) package. It is used in the Vite project to provide TypeScript types corresponding to Blazor's built-in object reference types.

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
        <RtBypassTypeScriptCompilation>false</RtBypassTypeScriptCompilation>
        <RtDisable>false</RtDisable>
        <RtSuppress>RTW0013;RTW0014;RT0008</RtSuppress>
    </PropertyGroup>
</Project>
```

With the `RtTargetFile` property, we instruct `Reinforced.Typings` to generate the types in the `typings.ts` file inside the `blazortsinteropexample` Vite project, which contains our TypeScript code. We also configure `Reinforced.Typings` to use the static `Configure` method of the `ReinforcedTypingsConfiguration` class we just implemented.

## Wiring the up the C# project

Before creating the `blazortsinteropexample` Vite project, let's configure our C# project so that type auto-generation and the Vite project build process are integrated into the incremental MSBuild build process:

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

First, we set a value for the `RtSettingsXml` property so that `Reinforced.Typings` knows where to find its settings at build time. We ensure there are no extra or missing slashes in the settings file's path by using the MSBuild utility function `EnsureTrailingSlash`.

Next, we explicitly include the `wwwroot\js\` folder in the project so that the JavaScript distributables it contains will be included in the .NET publish output.

We also override the default `CompileTypeScript` MSBuild target with an empty one to prevent MSBuild from attempting to build the TypeScript files inside the Vite project as part of the build process.

Finally, we create a new MSBuild target called `RunNpmBuild`. This target runs the `build_library.ps1` script using `pwsh` for cross-platform compatibility. The `build_library.ps1` script handles the incremental build of the Vite project. Before the C# project is built, we check whether the Vite project needs to be built, attempt to build it if necessary, and place the JavaScript distributables in the `wwwroot\js\` folder.

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

- There are no JavaScript distributables yet in the `wwwroot/js` directory,
- OR if any files in the Vite project have a more recent `LastWriteTime` than the current distributables.

If either condition is met, the Vite project is built. Note that we exclude the `typings.ts` file from the `LastWriteTime` comparison because `Reinforced.Typings` can regenerate the file even when no actual changes have been made.

## Creating the Vite Project

To create the Vite project, one should navigate to the desired directory — `Adapters/` under the C# project directory in our case — and run the following command:

```sh
npm create vite@latest

```

In our case the project name is `blazortsinteropexample` and we want to use the vanilla Vite and the TypeScript variant.

Next, we install `@types/blazor__javascript-interop` as a dev dependency:

```sh
npm install --save-dev @types/blazor__javascript-interop
```

Finally, since we use Prettier for code formatting, we want to exclude the auto-generated `typings.ts` file from its scope by adding a `.prettierignore` file under the Vite project with the following content:

```powershell
typings.ts
```

Assuming we have added the previously discussed `BrowserConsoleAdapter` skeleton to the C# project and run MSBuild, we should see the `typings.ts` file generated under the `src` directory of the Vite project with the following content:

```typescript
//     This code was generated by a Reinforced.Typings tool.
//     Changes to this file may cause incorrect behavior and will be lost if
//     the code is regenerated.

export interface IBrowserConsoleAdapter {
  logAsync(message: string): Promise<void>
}
```

Next, let's implement the `logAsync` TypeScript handler according to the earlier planned approach:

```typescript
// browserConsoleAdapter.ts

import { IBrowserConsoleAdapter } from "./typings"

async function logAsync(message: string) {
  console.log(message)
}

export default { logAsync } as IBrowserConsoleAdapter
```

Note that the last line, `export default { logAsync } as IBrowserConsoleAdapter`, binds everything together and ensures strong type safety:

- If members are added to or removed from the `BrowserConsoleAdapter` C# class, equivalent changes **must** be made to the `browserConsoleAdapter.ts` module's default export; otherwise, the Vite build — and thus the MSBuild — will fail. 🎉
- If the signature of an existing member in the `BrowserConsoleAdapter` C# class changes, equivalent changes **must** be made to the `browserConsoleAdapter.ts` module's default export; otherwise, the Vite build — and thus the MSBuild — will fail. 🎉

Finally, let's configure Vite to generate a `browserConsoleAdapter.js` module from the `browserConsoleAdapter.ts` module during the build process and output it to the JavaScript distributables directory under `wwwroot/js`. Let's make the following changes to the `vite.config.js` file:

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

We configure Vite to first clear the `wwwroot/js/dist` directory and then output the built JavaScript module for the `browserConsoleAdapter.ts` TypeScript module/entry point in the ESModule format. This allows us to import each module separately, either eagerly or lazily, as needed.

## `BrowserConsoleAdapter` – from C# to TypeScript

Let's finalize the implementation of the `BrowserConsoleAdapter` class skeleton that we added earlier. To invoke the `logAsync` (TypeScript) function from the adapter, it first needs to ensure that the `browserConsoleAdapter.js` module has been imported. After that, it can invoke the `logAsync` function, which has been exported as part of the `default` object:

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

We can inject `IJSRuntime` into the `BrowserConsoleAdapter` object and use it to import the `browserConsoleAdapter.js` module located in the `wwwroot/js/dist` directory.

Note that we annotate the `ImportModule` method with `TsIgnoreAttribute` to exclude it from the `typings.ts` auto-generation. We also add a `CancellationToken` parameter to the `LogAsync` method so that both the import and the remote invocation over interop can be gracefully canceled if needed. This parameter is also annotated with `TsIgnoreAttribute` because we don't want to pass `CancellationToken` objects as serialized JSON over interop.

Using `??=`, we ensure that the module import is attempted only once within the scope of a single adapter object. If another adapter object is instantiated and the import is attempted again, the usual JavaScript module caching conventions of the user's browser apply.

Let's add the `BrowserConsoleAdapter` class as a scoped service to the C# project's Dependency Injection container in the `Program.cs` file and use it to print greetings to the browser console:

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

Now, if we build and launch the Blazor application, the `button` component is shown which prints greetings to the browser console when clicked.

## `PointerEventsAdapter` – from TypeScript to C#

Earlier, we added the `HandleClickAtAsync` C# handler method to the `Home.razor` file. We want this method to be invoked whenever a user clicks on the page.

The TypeScript invoker must have access to a `DotNet.DotNetObject` (TypeScript) handle for the `Home` component object that will handle the invocation. While initializing the `Home` component, let's create a `DotNetObjectReference` (C#) handle that refers to the `Home` component object itself:

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

We also inject a `PointerEventsAdapter` object into the component and invoke its `AddForHandlerAsync` method. This method essentially passes the `DotNetObjectReference<Home>` (C#) handle from C# to TypeScript by invoking the `addForHandlerAsync` handler function of `pointerEventsAdapter.js`, a new JavaScript module that will be introduced shortly.

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

Instead of requiring the passed `DotNetObjectReference` handle to strictly refer to a `Home` component object, we use a generic parameter `THandler` with an interface constraint. This allows any class implementing the `IPointerEventsAdapterHandler` interface to be used for instantiating compatible C# handler objects.

So, let's create the `IPointerEventsAdapterHandler` interface and make the `Home` component implement it:

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

Note that the `HandleClickAtAsync` signature can't include a `CancellationToken` parameter because, in this case, invocations originate from TypeScript, where the concept of `CancellationToken` doesn't exist.

While we're at it, let's register the `PointerEventsAdapter` class as a scoped service in the `Program.cs` file:

```csharp
// Program.cs

builder.Services.AddScoped<PointerEventsAdapter>();
```

Now, when the C# project is built, new auto-generated types will be added to the `typings.ts` file:

```typescript
export interface IPointerEventsAdapterHandler {
  handleClickAtAsync(x: number, y: number): Promise<void>
}
export interface IPointerEventsAdapter {
  addForHandlerAsync<THandler>(handlerReference: DotNet.DotNetObject): Promise<void>
}
```

We can now implement the `pointerEventsAdapter` (TypeScript) handler module, which should export the `addForHandlerAsync` handler function. A naïve implementation of the handler would look like this:

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

With the naïve implementation, invoking the `HandleClickAtAsync` (C#) handler method would not utilize any of our auto-generated interfaces and would be fully dynamically typed.

Instead, let's create an `invokeHandler` utility TypeScript function to ensure that all C# handler method invocations from TypeScript are covered by TypeScript type checking:

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

By passing an auto-generated interface as an argument to the generic parameter `THandler`, `invokeHandler` ensures that the C# handler method we attempt to invoke is a member of the interface **and** that the passed parameters and return type match the member's signature 🎉.

So, our final implementation of the `pointerEventsAdapter` (TypeScript) handler looks like this:

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

Note that we store the `handlerReference` argument in the `handlerRef` variable so that other TypeScript handler functions added to the `pointerEventsAdapter` handler can reuse it. However, in our example implementation, this is not strictly required.

Finally, let's add the `pointerEventsAdapter.ts` file as a new entry point in `vite.config.js`, so that Vite will build the `pointerEventsAdapter.js` module:

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

Now, if we build and launch the Blazor application, we should see new entries appearing in the list on the page each time we click somewhere.

## Evaluation

The goals we set in the introduction of this article were met relatively well:

- Type changes in C# are automatically propagated to TypeScript by `Reinforced.Typings`. ✅
- We fully leverage TypeScript's type-checking capabilities, and type mismatches are automatically detected as part of the Blazor app's MSBuild process. ✅
- The Vite project is automatically built when necessary — and skipped when it's not — as part of the Blazor app's MSBuild process. ✅
- JavaScript modules can be re-imported during a Blazor debug session by simply refreshing the page. We can even configure Vite to watch for changes in files within the Vite project and automatically rebuild the distributables using the `npm watch` command. `npm watch` can run in parallel with a Blazor debug session. ✅

Naturally, the standard limitations of Blazor's JavaScript interop still apply. For example, our TypeScript handlers don't really understand C# object references, aside from the limited support provided by `DotNet.DotNetObject` handles. All communication still relies on simple JSON serialization.

Additionally, the caveats of TypeScript's duck-typing remain. For instance, if we removed the `message` parameter from the `logAsync` function in the `browserConsoleAdapter` (TypeScript) module, `logAsync` would still comply with the auto-generated `IBrowserConsoleAdapter` (TypeScript) interface due to duck-typing. However, changing the type of the `message` parameter or adding more parameters to the `logAsync` function — without making corresponding updates to the `BrowserConsoleAdapter` (C#) class — would be caught by type checking.
