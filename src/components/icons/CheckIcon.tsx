export function CheckIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="50" cy="50" r="42" fill="#dcfce7" stroke="#22c55e" strokeWidth="4" />
      <path d="M32 52 L45 65 L68 40" stroke="#22c55e" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
