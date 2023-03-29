import fs from "fs"
import matter from "gray-matter"
import path from "path"
import rehypeAutolinkHeadings from "rehype-autolink-headings/lib"
import rehypePrettyCode from "rehype-pretty-code"
import rehypeSlug from "rehype-slug"
import rehypeStringify from "rehype-stringify"
import remarkParse from "remark-parse"
import remarkRehype from "remark-rehype"
import { unified } from "unified"

type PostId = {
  year: string
  month: string
  day: string
  slug: string
}

type MatterData = {
  title: string
  prenote: string
  date: string
}

const postsDir = "posts"

function readMatter(fileName: string) {
  const filePath = path.join(postsDir, fileName)
  const post = fs.readFileSync(filePath, "utf-8")
  const result = matter(post)
  return {
    ...result,
    data: result.data as MatterData
  }
}

const processor = unified()
  .use(remarkParse)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeSlug)
  .use(rehypeAutolinkHeadings, {
    behavior: "wrap"
  })
  .use(rehypePrettyCode, { theme: { light: "github-light", dark: "github-dark" } })
  .use(rehypeStringify)

type GetPostByIdArgs = PostId
export async function getPostById(args: GetPostByIdArgs) {
  const { year, month, day, slug } = args

  const { content, data } = readMatter(`${year}${month}${day}-${slug}.md`)
  const postVFile = await processor.process(content)
  const postHtml = postVFile.toString()
  return {
    html: postHtml,
    ...data
  }
}

export function getPostInfosOrderedByDateDesc() {
  const fileNames = fs.readdirSync(postsDir).sort().reverse()
  const infos = fileNames.map(fn => {
    const { data, content } = readMatter(fn)
    const [date, ...rest] = fn.replace(/\.md$/, "").split("-")
    const slug = rest.join("-")
    const year = date.slice(0, 4)
    const month = date.slice(4, 6)
    const day = date.slice(6, 8)
    const id: PostId = { year, month, day, slug }
    const intro = content.substring(0, content.trimStart().indexOf("\n") + 1)
    return {
      id,
      intro,
      ...data
    }
  })
  return infos
}
