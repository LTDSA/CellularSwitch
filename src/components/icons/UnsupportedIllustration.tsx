export function UnsupportedIllustration({ className = '' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 200 160"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="40" y="80" width="120" height="70" rx="6" fill="#e5e7eb" stroke="#9ca3af" strokeWidth="2" />
      <rect x="48" y="88" width="104" height="54" rx="2" fill="#f9fafb" />
      <path d="M100 100 L100 130" stroke="#ef4444" strokeWidth="4" strokeLinecap="round" />
      <circle cx="100" cy="95" r="8" stroke="#ef4444" strokeWidth="3" />
    </svg>
  )
}
