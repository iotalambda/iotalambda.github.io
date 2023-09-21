import WrittenTime from "@/app/components/WrittenTime"
import { BASE_TITLE, getPostById, getPostInfosOrderedByDateDesc } from "@/lib"
import { Metadata } from "next"
import "./styles.css"

type PostProps = {
  params: { id: [string, string, string, string] }
}

export async function generateMetadata(props: PostProps): Promise<Metadata> {
  const [year, month, day, slug] = props.params.id
  const { title } = await getPostById({ year, month, day, slug })
  return {
    title: `${title} | ${BASE_TITLE}`
  }
}

export default async function Post(props: PostProps) {
  const [year, month, day, slug] = props.params.id
  const { html, title, prenote, date } = await getPostById({ year, month, day, slug })
  return (
    <div className="md:px-10 mb-20">
      <article>
        <header className="px-5 mb-4 py-10 relative">
          <h1 className="text-3xl leading-none tracking-tight text-gray-900 md:text-4xl lg:text-5xl dark:text-gray-100">
            {title}
          </h1>
          <WrittenTime date={date} className="absolute" />
        </header>
        <div className="bg-slate-100 dark:bg-slate-800 p-5 rounded shadow-lg">
          {prenote && (
            <>
              <p className="italic text-slate-400 p-4" dangerouslySetInnerHTML={{ __html: prenote }} />
              <hr className="h-px my-4 bg-gray-200 border-0 dark:bg-gray-700" />
            </>
          )}
          <div className="space-y-4" dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      </article>
    </div>
  )
}

export async function generateStaticParams() {
  const infos = getPostInfosOrderedByDateDesc()
  return infos.map(({ id }) => ({ id: Object.values(id) }))
}
