---
title: Debuggable Scripting with TypeScript and ClearScript
date: 2022-11-28 21:00
prenote: The code samples provided in this blog post are available at <a href="https://github.com/iotalambda/ClearScriptV8Poc">ClearScriptV8Poc</a>.
---

When a system grows, you may want to consider supporting scripting for more dynamic and advanced customization. Ideally, an untrusted developer or customizer should be able to upload a script to the system, which becomes part of the final flow of execution.

Although JavaScript is a popular choice for a scripting language, when there are complex contracts that the customizer must comply with and rely on, having types can save you from a world of pain. It wouldn't be too much to ask if we required our customizers to use TypeScript instead.

Besides types and choosing a language, it is also necessary to offer the customizers a way to debug their scripts, especially once the script logic has evolved into a no-longer-trivial state. In this blog post, we will explore a way to potentially achieve this:

- **Use TypeScript as the scripting language**
- **Use .NET and ClearScript to run the scripts**
- **Use Edge DevTools for debugging them**

[ClearScript](https://github.com/microsoft/ClearScript) is a seemingly well-supported .NET-based wrapper around V8, Google's JavaScript engine. This means that ClearScript supports ECMAScript just as much as V8 implements it. There are several other means for running JavaScript on .NET, such as [Jint](https://github.com/sebastienros/jint), which is a JavaScript interpreter and in many situations faster than ClearScript. However, in our scenario, we want to be able to leverage existing tooling around V8 such as debuggers supporting the [V8 Inspector Protocol](https://v8.dev/docs/inspector).

ClearScript does not implement Node APIs or Web APIs, which in itself offers us a relatively closed sandbox. However, a buggy or malicious script could still hog all the CPU and memory or simply run in a loop forever. These things are not discussed in this blog post, but they should be considered for a production-ready solution.

## Create a script

First, let's create a simple piece of TypeScript that we'd like to run on our hypothetical service:

```ts
// index.ts
export const run = (): number => {
  console.log("Enter run")
  let value = 5
  console.log("Break")
  debugger
  value += 2
  console.log("Exit run")
  return value
}
```

Our sample here doesn't utilize the type system that much, but at least it has the return type `: number` set. That's enough for us for now. Also, we will use ES6-style modules for our purposes. Ideally, the customizer would create and publish a module as a package, and then our system would be able to import it.

Note that the script uses `console`, which is part of the Web API but not V8. Therefore, the platform that we will create must provide the global `console` object, or it will be `undefined`.

## Build the script

Next, let´s add `tsconfig.json`:

```json
// tsconfig.json
{
  "compilerOptions": {
    "outDir": "./dist/",
    "sourceMap": true,
    "target": "es5",
    "module": "es6",
    "moduleResolution": "node"
  }
}
```

The transpiled JavaScript should contain an ES6-style module. Notice that we enable _source map_ file generation with `"sourceMap": true`. The source map files will contain a mapping between the TypeScript source code and the transpiled JavaScript "binary". V8 knows only JavaScript so source maps can be used to tell debuggers how the executed JavaScript is connected to the TypeScript source code. The output will essentially be two files: `index.js` and `index.js.map`, but both of them are immediately consumed by Webpack.

So Webpack is the build tool of our choice (could have used e.g. `esbuild` as well):

```js
// webpack.config.js
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default {
  mode: "development",
  entry: "./src/index.ts",
  devtool: "inline-source-map",
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: "ts-loader",
        exclude: /node_modules/
      }
    ]
  },
  resolve: {
    extensions: [".ts", ".js"]
  },
  output: {
    filename: "bundle.js",
    path: path.resolve(__dirname, "dist"),
    library: {
      type: "module"
    }
  },
  experiments: {
    outputModule: true
  }
}
```

We use `ts-loader` to load the TypeScript files and finally output `bundle.js`, which exports a module. Notice the line `devtool: inline-source-map`: we bundle the previously generated `.js.map` files into `bundle.js` so that the debugger will later be able to catch the source map from `bundle.js`. We could have also used just `devtools: source-map` to generate a separate `bundle.js.map`, but we'll use the inline version for simplicity.

After running `npx webpack`, `bundle.js` is generated under `/dist/`, and the file contains the inline source maps as expected.

## Implementing the host

Next, let´s create a ClearScript V8 host that will run the script:

```csharp
// Program.cs
using Microsoft.ClearScript;
using Microsoft.ClearScript.JavaScript;
using Microsoft.ClearScript.V8;

var engine = new V8ScriptEngine(V8ScriptEngineFlags.EnableDebugging, 9222);
dynamic setupConsole = engine.Evaluate("writeLine => console = { log: message => writeLine(message) }");
setupConsole(new Action<string>(Console.WriteLine));

var js = File.ReadAllText("..\\..\\..\\..\\..\\demo\\dist\\bundle.js");
engine.DocumentSettings.AddSystemDocument("bundle", ModuleCategory.Standard, js);
dynamic exports = engine.Evaluate(new DocumentInfo { Category = ModuleCategory.Standard }, "import * as exports from 'bundle'; exports");

Console.WriteLine("Open your debugger and hit enter");
Console.ReadLine();
exports.run();
```

- **Line 6**: Set up the ClearScript V8 with `ScriptEngineFlags.EnableDebugging`, which starts a listener on port `9222`, the standard port for debugging Node.js.
- **Lines 7-8**: Create the global `console` object so that `console.log` will `Console.WriteLine`. Note that we could have also used `engine.AddHostObject("console", ...)` to create the `console` object, but this would have also exposed the standard `System.Object` members such as `GetHashCode` to the script. We prefer not having those as part of our API that we provide to our customizers.
- **Lines 10-12**: Load the previously generated bundle and then import and export it in an inline code block so that it can be marshaled with a CLR object `dynamic exports`.
- **Lines 14-16**: Wait for a debugger to attach to the listener. Depending on the debugger, it may take a second or two. Once the debugger has been attached, the user should hit ENTER, and then the `run()` function exported by our TypeScript module will be executed.

## Debug the script

Finally, let's try debugging:

1. Open up Edge Remote Targets by browsing to `edge://inspect`.
2. Run the .NET console app.
3. Wait for Edge to locate the listener and then click `inspect`.
4. Hit ENTER in the console app.
5. Wait for Edge DevTools debugger to attach to the process.

Then, the debugger in Edge DevTools will break at the `debugger` statement of the original TypeScript code! _And_ the inspected function has the `: number` return type 😎.

![](debuggable-scripting-edge.png)

## Considerations

As we can see, ClearScript supports the desired flow. However, as explained earlier, there are some caveats too. Besides the mentioned risks in executing untrusted code, one has to be aware that V8 is not Node.js and therefore ClearScript doesn't include Node's event loop. This means that the hypothetical script host would be single-threaded per `V8ScriptEngine` instance (and each instance has a non-trivial memory overhead). But one could work around this to some extent by [pooling `V8ScriptEngine` instances](https://github.com/Microsoft/ClearScript/issues/53#issuecomment-387387543).

Also, in a real-life debugging scenario, the customizer would use _remote debugging_, which is enabled in ClearScript with the `V8ScriptEngineFlags.EnableRemoteDebugging` flag. This naturally exposes new attack vectors that must be addressed appropriately. [The official Node.js guide for remote debugging](https://nodejs.org/en/docs/guides/debugging-getting-started/#enabling-remote-debugging-scenarios) is a good starting point.
