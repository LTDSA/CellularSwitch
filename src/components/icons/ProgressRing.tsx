export function ProgressRing({ className = '' }: { className?: string }) {
  return (
    <svg
      className={`animate-spin ${className}`}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle
        cx="50"
        cy="50"
        r="42"
        stroke="#e5e7eb"
        strokeWidth="8"
      />
      <circle
        cx="50"
        cy="50"
        r="42"
        stroke="#007aff"
        strokeWidth="8"
        strokeLinecap="round"
        strokeDasharray="220"
        strokeDashoffset="55"
      />
    </svg>
  )
}
