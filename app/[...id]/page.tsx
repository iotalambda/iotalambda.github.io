import WrittenTime from "@/app/components/WrittenTime"
import { BASE_TITLE, getPostById, getPostInfosOrderedByDateDesc } from "@/lib"
import { Metadata } from "next"
import { notFound } from "next/navigation"
import "./styles.css"

type PostProps = {
  params: { id: [string, string, string, string] }
}

function isValidPostId(id: string[]): id is [string, string, string, string] {
  return id.length === 4 && /^\d{4}$/.test(id[0]) && /^\d{2}$/.test(id[1]) && /^\d{2}$/.test(id[2])
}

export async function generateMetadata(props: PostProps): Promise<Metadata> {
  if (!isValidPostId(props.params.id)) {
    return { title: BASE_TITLE }
  }
  const [year, month, day, slug] = props.params.id
  const { title } = await getPostById({ year, month, day, slug })
  return {
    title: `${title} | ${BASE_TITLE}`
  }
}

export default async function Post(props: PostProps) {
  if (!isValidPostId(props.params.id)) {
    notFound()
  }
  const [year, month, day, slug] = props.params.id
  const { html, title, prenote, date } = await getPostById({ year, month, day, slug })
  return (
    <div className="flex justify-center">
      <div className="md:px-10 min-w-0 max-w-7xl mb-12">
        <article>
          <header className="px-5 mb-4 py-10 relative">
            <h1 className="text-3xl leading-none tracking-tight text-gray-900 md:text-4xl lg:text-5xl dark:text-gray-100">
              {title}
            </h1>
            <WrittenTime date={date} className="absolute" />
          </header>
          <div className="bg-slate-100 dark:bg-slate-800 p-5 pb-12 rounded shadow-lg">
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
    </div>
  )
}

export async function generateStaticParams() {
  const infos = await getPostInfosOrderedByDateDesc()
  return infos.map(({ id }) => ({ id: Object.values(id) }))
}
