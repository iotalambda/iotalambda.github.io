---
title: Transparent Backgrounds with OpenAI DALL-E 3
date: 2025-12-10 16:00
---

OpenAI's new [`gpt-image-1`](https://platform.openai.com/docs/models/gpt-image-1) model supports [native transparent backgrounds](https://docs.aimlapi.com/api-references/image-models/openai/gpt-image-1#generate-image) via a simple `background: "transparent"` parameter. Unfortunately, accessing this model via API requires verifying your organization by submitting a copy of your government-issued ID to [Persona](https://withpersona.com/), a third-party American identity verification service. This has [proven to have several problems](https://community.openai.com/t/the-broken-openai-persona-identity-verification-what-it-is-and-why-its-problematic/1354535), confidentiality not being the least of them.

Luckily, OpenAI's deprecated (but still active) [DALL-E 3](https://platform.openai.com/docs/models/dall-e) model can achieve the same result with a workaround: [green screen](https://en.wikipedia.org/wiki/Chroma_key).

<img src="/dalle3-greenscreen-example.png" alt="Case in point" width="400" style="float: right; margin-right: 1rem; margin-bottom: 0.5rem" />

## Prompting for Green Screen

Append the following to your image generation prompt:

```
IMPORTANT: The background MUST be a solid, flat, unlit, pure green color
with hex value #00b140. No gradients, no shadows, no variations - just
perfectly uniform #00b140 green background. The background is essentially
a green screen for chroma keying later in the process, so avoid that color
in the actual image content.
```

The hex value `#00b140` is a specific shade of green that's unlikely to appear in the actual image subject. You could use other green shades, but this one works well in practice.

## Detecting the Actual Background Color

LLMs are not precise when it comes to exact colors. Even with explicit instructions to use `#00b140`, the generated image might have a slightly different green tone or vary slightly across the image.

This can be managed by sampling pixels near the generated image's borders (where background is most likely to be) and calculating their median color:

```csharp
private static Rgba32 DetectBackgroundColor(Image<Rgba32> image)
{
    var random = new Random(42); // Fixed seed for reproducibility
    var samples = new List<Rgba32>();
    var width = image.Width;
    var height = image.Height;

    // Sample 100 pixels near the borders (within 5% of width/height)
    var maxBorderX = (int)(width * 0.05);
    var maxBorderY = (int)(height * 0.05);

    for (var i = 0; i < 100; i++)
    {
        int x, y;

        // Randomly choose which border region to sample from
        var edge = random.Next(4);
        switch (edge)
        {
            case 0: // Top edge
                x = random.Next(width);
                y = random.Next(maxBorderY);
                break;
            case 1: // Bottom edge
                x = random.Next(width);
                y = height - 1 - random.Next(maxBorderY);
                break;
            case 2: // Left edge
                x = random.Next(maxBorderX);
                y = random.Next(height);
                break;
            default: // Right edge
                x = width - 1 - random.Next(maxBorderX);
                y = random.Next(height);
                break;
        }

        samples.Add(image[x, y]);
    }

    // Calculate median for each channel
    var rValues = samples.Select(p => (int)p.R).OrderBy(v => v).ToList();
    var gValues = samples.Select(p => (int)p.G).OrderBy(v => v).ToList();
    var bValues = samples.Select(p => (int)p.B).OrderBy(v => v).ToList();

    var medianR = (byte)rValues[rValues.Count / 2];
    var medianG = (byte)gValues[gValues.Count / 2];
    var medianB = (byte)bValues[bValues.Count / 2];

    return new Rgba32(medianR, medianG, medianB, 255);
}
```

Using the median (rather than the mean) makes the detection robust against outliers — edge pixels might include parts of the subject that spill into the border region.

## Applying Tolerance

After detecting the actual background color, we still need _tolerance_ when comparing pixels, due to subtle variations in the generated background.

```csharp
private static bool IsChromaKeyGreen(Rgba32 pixel, Rgba32 target)
{
    const int tolerance = 40; // Adjust this as needed

    var dr = Math.Abs(pixel.R - target.R);
    var dg = Math.Abs(pixel.G - target.G);
    var db = Math.Abs(pixel.B - target.B);

    return dr <= tolerance && dg <= tolerance && db <= tolerance;
}
```

A tolerance of 40 (out of 255) seems to catch most background variations while avoiding false positives on the subject.

## The Complete Implementation

Here's a complete C# implementation using [ImageSharp](https://github.com/SixLabors/ImageSharp) for image processing:

```csharp
public async Task<byte[]> GenerateImageAsync(
    string model,
    string prompt,
    bool transparentBackground = false,
    CancellationToken cancellationToken = default)
{
    var client = new ImageClient(model, _config.OpenAi.ApiKey);

    var finalPrompt = prompt;
    if (transparentBackground)
    {
        finalPrompt +=
            "\n\nIMPORTANT: The background MUST be a solid, flat, unlit, " +
            "pure green color with hex value #00b140. No gradients, no shadows, " +
            "no variations - just perfectly uniform #00b140 green background. " +
            "The background is essentially a green screen for chroma keying later " +
            "in the process, so avoid that color in the actual image content.";
    }

    var options = new ImageGenerationOptions
    {
        ResponseFormat = GeneratedImageFormat.Bytes,
        Size = GeneratedImageSize.W1024xH1024,
        Quality = GeneratedImageQuality.High,
    };

    var result = await client.GenerateImageAsync(finalPrompt, options, cancellationToken);
    var imageBytes = result.Value.ImageBytes.ToArray();

    if (transparentBackground)
    {
        imageBytes = ChromaKeyGreen(imageBytes);
    }

    return imageBytes;
}

private static byte[] ChromaKeyGreen(byte[] imageBytes)
{
    using var image = Image.Load<Rgba32>(imageBytes);

    var targetGreen = DetectBackgroundColor(image);

    image.ProcessPixelRows(accessor =>
    {
        for (var y = 0; y < accessor.Height; y++)
        {
            var row = accessor.GetRowSpan(y);
            for (var x = 0; x < row.Length; x++)
            {
                var pixel = row[x];
                if (IsChromaKeyGreen(pixel, targetGreen))
                {
                    row[x] = new Rgba32(0, 0, 0, 0);
                }
            }
        }
    });

    using var outputStream = new MemoryStream();
    var encoder = new PngEncoder { ColorType = PngColorType.RgbWithAlpha };
    image.SaveAsPng(outputStream, encoder);
    return outputStream.ToArray();
}
```

## Evaluation

This approach works well for most use cases, but has some limitations:

- **No anti-aliasing** between the transparent background and the foreground. A proper solution would involve calculating partial transparency based on how close each pixel is to the target color.

- **Green pixel islands**: Occasionally, small isolated patches of greenish pixels remain in what should be transparent areas. Ideally these would be detected and removed.

...and also DALL-E 3 is [scheduled to shut down](https://community.openai.com/t/openai-is-making-a-huge-mistake-by-deprecating-dall-e-3/1367228) in 2026.
