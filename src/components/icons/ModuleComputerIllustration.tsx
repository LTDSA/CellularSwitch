export function ModuleComputerIllustration({ className = '' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 200 160"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Mac 通过 Type-C 连接 4G 模块"
    >
      <g
        stroke="#7e858f"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* Mac display */}
        <path d="M18 119V50a7 7 0 0 1 7-7h111a7 7 0 0 1 7 7v69" />
        <path
          d="M21 119V51a5 5 0 0 1 5-5h109a5 5 0 0 1 5 5v68"
          stroke="#a3a9b1"
          strokeWidth="1"
        />

        {/* Complete Mac base */}
        <path
          data-mac-base="true"
          d="M8 119h144v5a6 6 0 0 1-6 6H14a6 6 0 0 1-6-6v-5Z"
          fill="#f1f2f4"
        />
        <path d="M68 119v1.5a3.5 3.5 0 0 0 3.5 3.5h17a3.5 3.5 0 0 0 3.5-3.5V119" />

        {/* Type-C connector and cable */}
        <rect
          data-type-c-connector="true"
          x="152"
          y="120.5"
          width="7"
          height="4"
          rx="1.2"
          fill="#e5e7eb"
        />
        <path d="M159 122.5h10a7 7 0 0 0 7-7V76" />

        {/* 4G module */}
        <rect x="164" y="18" width="24" height="58" rx="6" fill="#f3f4f5" />
        <rect
          x="166"
          y="20"
          width="20"
          height="54"
          rx="4.5"
          stroke="#a3a9b1"
          strokeWidth="1"
        />

        {/* Cellular signal */}
        <rect data-signal-bar="true" x="171" y="43" width="2" height="4" rx="1" fill="#9299a2" stroke="none" />
        <rect data-signal-bar="true" x="175" y="40" width="2" height="7" rx="1" fill="#9299a2" stroke="none" />
        <rect data-signal-bar="true" x="179" y="37" width="2" height="10" rx="1" fill="#9299a2" stroke="none" />

        {/* Status light */}
        <circle data-status-light="true" cx="182.5" cy="68.5" r="1.8" fill="#22c55e" stroke="none" />
      </g>
    </svg>
  )
}
