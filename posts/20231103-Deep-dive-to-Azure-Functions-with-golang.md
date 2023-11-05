---
title: Deep dive to Azure Functions with Go
date: 2023-11-03 00:00
prenote: The code discussed in this blog post is available on <a href="https://github.com/iotalambda/beenotif">GitHub</a>.
---

Azure Functions has supported _Custom Handlers_ since 2020. With Custom Handlers any web server that is able to run on one the available Azure Functions platforms can function as a handler. So in this article we'll delve into the details of implementing a timer triggered Azure Function with Go – Go not being a first-class citizen in the Azure Functions world (unlike C#, Java, JavaScript, TypeScript, Python and PowerShell).

My goal was to create a scheduled task that is able to scrape data from a web page periodically and send me a push notification if the data has changed. Ultimately I ended up creating a relatively generic solution for this purpose, available in the git repo.

## Setting up the project

Following the [Microsoft tutorial](https://learn.microsoft.com/en-us/azure/azure-functions/create-first-function-vs-code-other?tabs=go%2Clinux), we end up with an empty Azure Functions project and several open questions. We'd like to create a timer triggered function, so we can simply ditch the default HTTP triggered function and execute `func new -l Custom -t TimerTrigger -n timer`.

In the newly created `timer` directory we now have a `function.json` file:

```json
{
  "bindings": [
    {
      "name": "myTimer",
      "type": "timerTrigger",
      "direction": "in",
      "schedule": "0 */5 * * * *"
    }
  ]
}
```

It's all quite clear. The `name` property seems a bit suspicious, but I suppose it's just a name for an individual schedule (could be e.g. "hourly"), and not something that affects the control flow that much.

Next the `host.json` file. Our Go web server implementation will be an executable, so the `customHandler` section should be configured as follows:

```json
{
  "version": "2.0",
  "logging": {
    "applicationInsights": {
      "samplingSettings": {
        "isEnabled": true,
        "excludedTypes": "Request"
      }
    }
  },
  "extensionBundle": {
    "id": "Microsoft.Azure.Functions.ExtensionBundle",
    "version": "[4.*, 5.0.0)"
  },
  "customHandler": {
    "description": {
      "defaultExecutablePath": "build/beenotif",
      "workingDirectory": "",
      "arguments": []
    }
  }
}
```

and therefore `build` should be added to `.gitignore`. Initially I used `bin/beenotif` as the `defaultExecutablePath`, but for some reason Azure Functions deployment did not want to upload the `bin` directory contents to the Function App at all, so there must be some undocumented logic which prevents that.

Finally, we need to initialize a Go module:

```sh
go mod init beenotif
```

with a temporarily empty `main.go`:

```go
package main

func main() {
}
```

and our Function App is able to build and run locally:

```sh
go build -o build/ && func start
```

## The handler

Microsoft's tutorial page offers an example on how to create an HTTP triggered function, but finding out how to create a timer triggered one took some trial and effort. Apparently, an HTTP handler with a pattern `/functionNameHere` will be the one invoked based on the CRON schedule - functionNameHere being the name used in the `func new` command. So in our case the correct pattern is `/timer`:

```go
http.HandleFunc("/timer", func(w http.ResponseWriter, r *http.Request) {
		fmt.Print("Hey!\n")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		_, err = w.Write([]byte("{}"))
		if err != nil {
			log.Fatal("Could not write response.")
		}
})
```

Note that the handler must return something, or otherwise the function execution [will never be marked as completed](https://learn.microsoft.com/en-us/answers/questions/614450/custom-handler-function-not-marking-run-as-complet).

## Scraping with `chromedp`

`chromedp` offers a surprisingly effective toolkit for our web scraping needs. The page we need to do scraping on is an SPA, so a simple `GET` wouldn't do it, but instead we need to launch a headless browser in our service, download the SPA and let the SPA's JavaScript do its thing before scraping:

```go
err := chromedp.Run(dpctx,
	chromedp.Navigate(config.TargetUrl),
	chromedp.Sleep(time.Duration(config.WaitSeconds)*time.Second),
	chromedp.EvaluateAsDevTools(config.StringArrayJs, &items),
)
```

With `EvaluateAsDevTools` we are able to run JavaScript and DOM queries exactly like in a full fledged Chrome.

`chromedp` requires a `chrome` executable to function and apparently there [has](https://learn.microsoft.com/en-us/answers/questions/1354174/cannot-find-chrome-binary-in-azure-function-app) [been](https://anthonychu.ca/post/azure-functions-headless-chromium-puppeteer-playwright/) [some](https://stackoverflow.com/questions/65609204/puppeteer-throws-launch-exception-when-deployed-on-azure-functions-node-on-linux) issues with it in the Consumption Plan. One of the ways to deal with this is naturally to have the Function App running in a container with all the necessary dependencies. But Consumption Plan does not support Docker, so I'd need to pay a non-zero amount of money for other tiers and that's unacceptable. But we can simply omit this issue by downloading prebuilt Chromium binaries and deploying them along the application.

In [chromium.org](https://www.chromium.org/getting-involved/download-chromium/) there's a link to a [repo](https://github.com/scheib/chromium-latest-linux) with a [script](https://github.com/scheib/chromium-latest-linux/blob/master/update.sh) that downloads the latest binaries. That could be tweaked for our needs and our directory structure! The tweaked version is in [publish.sh](https://github.com/iotalambda/beenotif/blob/main/publish.sh). This script file is meant to be executed either manually before deploying from VSCode or automatically by pipelines.

The last thing to do is tell `chromedp` where the binary is. We can implement our own `ExecAllocator`:

```go
allocatorCtx, _ := chromedp.NewExecAllocator(
	ctx,
	append([]func(allocator *chromedp.ExecAllocator){
		chromedp.ExecPath(sc.ChromiumPath),
	}, chromedp.DefaultExecAllocatorOptions[:]...)...,
)
```

It devours a context and returns another one, which we must later provide to `chromedp.Run(...)`, so that the prebuilt Chromium binary is really used.

## **BONUS**: A brief note about Azure Tables

I needed a cheap lightweight storage to back my scraper and decided to go with _Azure Tables_ as I had the Storage Account there anyway due to Azure Functions. I invested some time in testing different Go libraries for Azure Tables and there seems to be at least three options, some official, some unoffical, some no longer maintained. But as for right now, the way to go seems to be [azure-sdk-for-go aztables](https://github.com/Azure/azure-sdk-for-go/tree/main/sdk/data/aztables).
