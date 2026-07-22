import type * as React from 'react'

import { cn } from '@/lib/utils'

function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    <label
      className={cn('flex flex-col gap-2 text-sm font-medium leading-none', className)}
      data-slot="label"
      {...props}
    />
  )
}

export { Label }
