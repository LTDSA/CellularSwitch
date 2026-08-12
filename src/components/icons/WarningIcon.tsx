export function WarningIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="50" cy="50" r="42" fill="#ffedd5" stroke="#f97316" strokeWidth="4" />
      <path d="M50 34 L50 58" stroke="#f97316" strokeWidth="6" strokeLinecap="round" />
      <circle cx="50" cy="70" r="4" fill="#f97316" />
    </svg>
  )
}
