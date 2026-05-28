import '@testing-library/jest-dom/vitest'
import React from 'react'
import { act } from 'react-dom/test-utils'

if (!(React as typeof React & { act?: typeof act }).act) {
  ;(React as typeof React & { act?: typeof act }).act = act
}
