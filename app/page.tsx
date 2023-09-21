import Link from "next/link"

import WrittenDate from "@/app/components/WrittenTime"
import { BASE_TITLE, getPostInfosOrderedByDateDesc } from "@/lib"

export const metadata = {
  title: `Articles | ${BASE_TITLE}`
}

export default function Home() {
  const postInfos = getPostInfosOrderedByDateDesc()
  return (
    <ol className="flex flex-col justify-center items-center gap-4">
      {postInfos.map((p, i) => {
        const { id, date, title, intro } = p
        const { year, month, day, slug } = id
        return (
          <li key={i} className="w-[min(800px,100%)]">
            <Link
              href={`/${year}/${month}/${day}/${slug}`}
              className="bg-slate-100 dark:bg-slate-800 inline-block rounded-sm shadow-md px-3 py-5 relative w-full"
            >
              <WrittenDate date={date} />
              <div className="pl-2">
                <h3 className="text-xl py-2">{title}</h3>
                <p className="text-sm text-slate-600 dark:text-slate-300">{intro}</p>
              </div>
            </Link>
          </li>
        )
      })}
    </ol>
  )
}
