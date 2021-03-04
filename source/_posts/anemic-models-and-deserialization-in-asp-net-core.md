---
title: Anemic models and deserialization in ASP.NET Core
date: 2021-03-04 10:00:00
categories: dotnet
---

<i>Anemic models</i> are the antithesis for <i>domain models</i>. They can be useful especially in extremey generic scenarios, in which there is really no single domain that one could or would like to model and support. In my hubmble opinion ASP.NET Core´s Web API convention is much more suitable for domain models, as its API models are strongy typed classes and the entire ecosystem (e.g. validation, API specification...) is built on top of this.

The strictly defined and structured world of ASP.NET Core sometimes poses a contrast to the fluid and dynamic world of the JavaScript saturated web - the glue between the two worlds being <i>JSON</i>.

In general, JSON binds spectaculary well to C# classes, but, regarding anemic models, there´s one major contradiction in the nature of <i>properties</i>: In JSON properties <i>can be or be not</i>, but in ASP.NET properties <i>always are</i>. In other words, ASP.NET core properties "cannot not be". For example, consider the following C# class:

```csharp
public class MyModel
{
  public string MyProperty { get; set; }
}
```

1) If we bind `{ "myProperty": "MY_VALUE" }`, then `MyProperty == "MY_VALUE"`
2) If we bind `{ "myProperty": null }`, then `MyProperty == null`
3) If we bind `{ }` , then `MyProperty == null`

The problem is that the <i>intention</i> between the last two cases is different. In case 2. the requestor wants to set the value of `MyProperty` to `null`, whereas in case 3. the requestor actually wants to leave the value <i>as is</i>. It can be that the requestor does not have permission to that property, or that the anemic data model has been extended with new properties that the requestor is not even aware of, or that the requestor just does not want to touch those properties in this situation. Whatever the case, the battle-tested convention of ASP.NET Core does not seem to support <i>differentiating `null`s from non-existing JSON properties</i>. We have to figure out something else.

Overall, it would be ideal to somehow have gain support for the following aspects typically related to anemic models:
* Partial updates (patching)
* Field based permissions

We´d still want to leverage the entire ASP.NET Core ecosystem, and thus we should not disenfranchise any de-facto ways of doing, such as:
* (De)serialization with JSON.NET
* Auto-mappability with AutoMapper
* OpenAPI spec generation with Swashbuckle
* Validation and model binding

...so the scope of the problem domain is rather huge. I suppose the entire discussion will be a multi-parter, but let´s start with the most basic requirements: deserialization and model binding, since without those we would not have data.

## Property<>

Let's refine the example and invent a magic type, `Property<>`:

```c#
public class MyModel
{
  public Property<string> MyProperty { get; set; }
}
```

`Property<>` would be something that contains at least the information about whether the correspoding JSON property existed or not, and if it did, then also its value:

```c#
public class Property<TValue> : Property
{
  public TValue Value => ObjValue;
  
  public Property(TValue value, bool hasValue)
    base(value, hasValue)
  {
  }
}

[JsonConverter(typeof(PropertyJsonConverter))]
public class Property
{
  public object ObjValue { get; }
  
  public bool HasValue { get; }
  
  public Property(object value, bool hasValue)
  {
    ObjValue = value;
    
    HasValue = hasValue;
  }
}
```

I also created a `Property` base class to accompany the generic `Property<>`, because things will get quite <i>reflection-y</i> very quickly and joggling with plain `object`s, rather than generics, as much as possible under the hood is more straight forward. We will likely refine this structure <i>at some point</i>, but let´s leave it as is for now. Naturally we should first create a `JsonConverter` for this class or otherwise the `Value` and `HasValue` would be part of our API model, which we do not want. We want to have `HasValue` to indicate whether the JSON property was there or not.

## JsonConverter

For deserialization, we should first define how JSON should be read. We expect JSON to have three kinds of <i>values</i>: simple (e.g. string), object and arrays. Each of these have their own deserialization quirks.

```csharp
public class PropertyJsonConverter : JsonConverter<Property>
{
  public override CanRead => true;

  public Property ReadJson(JsonReader reader, Type objectType, Property existingValue,
    bool hasExistingValue, JsonSerializer serializer)
  {
    object value; // This shall contain the Value inside our Property<>, e.g. "myString"

    switch (reader.TokenType)
    {
      case JsonToken.StartObject: // It is a JSON object
      case JsonToken.StartArray: // or a JSON array
        
        // .GetGenericArgument() is just util for .GetGenericArguments()[0].
        // Let's find out what the TValue in Property<TValue> is
        var innerType = objectType.GetGenericArgument();

        // In case of objects and arrays we have to recurse deeper to the hierarchy, as
        // there may be Property<>s somewhere there!
        var innerReader = JObject.Load(reader).CreateReader();
        value = serializer.Deserializer(innerReader, innerType);
        break;

      default: // All else is just simple values which we can use as is
        value = reader.Value;
        break;
    }

    // ...and finally we just create the Property<>!
    // Note that objectType is the type of the C# property, e.g. typeof(Property<MyString>)
    return Activator.CreateInstance(objectType, new object[] { value, true }) as Property;
  }
}
```

There was some issues with simple (value) types, as boxed `value` holds only the actual property value and not its type. Thus, after line `29` of the code block above, I added additional conversion that normalizes e.g. nullability and integer bitness.

## It works!

Now we can test this with a very simple action

```csharp
public class MyController : ControllerBase
{
  [HttpPost]
  public ActionResult Post([FromBody] MyModel myModel)
  {
    return Ok();
  }
}
```
and even simpler requests
```json
{ "myProperty": "MY_VALUE" }
```
```json
{ "myProperty": null }
```
```json
{ }
```
and each case is truly deserialized and bound to `myModel` as expected: `HasValue` is `false` in the lattermost scenario.

There is still a plethora of viewpoints to investigate, but this result is at least slightly encouraging. I pushed the code to a [GitHub repo](https://github.com/iotalambda/Lattia). In the next part I will discuss the other side of the coin, serialization, and a very related topic, auto-mapping back and forth between models with `Property<>`s and more standard entity classes. For clarity, I'll call this <i>endeavour/project</i> "Lattia", since it aims to refine some of the most basic building blocks for anemic APIs 😉.