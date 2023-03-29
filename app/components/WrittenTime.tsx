type WrittenDateProps = {
  date: string
  className?: string
}

function WrittenDate(props: WrittenDateProps) {
  const { date, className } = props
  return (
    <time dateTime={date} className={`pl-1 font-serif text-slate-400 bottom-0 ${className}`}>
      <svg
        className="h-4 w-4 inline-block"
        width="24"
        height="24"
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 19l7-7 3 3-7 7-3-3z" /> <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />{" "}
        <path d="M2 2l7.586 7.586" /> <circle cx="11" cy="11" r="2" />
      </svg>{" "}
      {date}
    </time>
  )
}

export default WrittenDate
