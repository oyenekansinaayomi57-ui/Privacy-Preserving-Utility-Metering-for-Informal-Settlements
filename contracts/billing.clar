;; contracts/billing-contract.clar
(define-constant ERR-NOT-AUTHORIZED u100)
(define-constant ERR-METER-NOT-REGISTERED u101)
(define-constant ERR-PERIOD-NOT-CLOSED u102)
(define-constant ERR-BILL-ALREADY-CALCULATED u103)
(define-constant ERR-INVALID-RATE u104)
(define-constant ERR-BILL-NOT-FOUND u105)
(define-constant ERR-INVALID-SETTLEMENT u106)
(define-constant ERR-OVERFLOW u107)
(define-constant ERR-ZERO-USAGE u108)
(define-constant ERR-RATE-NOT-SET u109)

(define-data-var admin principal tx-sender)
(define-data-var rate-per-unit uint u150)
(define-data-var currency (string-ascii 10) "STX")

(define-map settlement-rates
  uint
  uint
)

(define-map user-bills
  { meter-id: principal, period: uint }
  { usage: uint, amount-due: uint, calculated-at: uint, paid: bool, settlement-id: uint }
)

(define-map period-totals
  uint
  { total-usage: uint, total-billed: uint, bill-count: uint }
)

(define-read-only (get-admin)
  (var-get admin)
)

(define-read-only (get-global-rate)
  (var-get rate-per-unit)
)

(define-read-only (get-settlement-rate (settlement-id uint))
  (map-get? settlement-rates settlement-id)
)

(define-read-only (get-user-bill (meter-id principal) (period uint))
  (map-get? user-bills { meter-id: meter-id, period: period })
)

(define-read-only (get-period-totals (period uint))
  (map-get? period-totals period)
)

(define-private (validate-admin)
  (is-eq tx-sender (var-get admin))
)

(define-private (is-period-closed (period uint))
  (let ((period-info (contract-call? .meter-data-contract get-period-info period)))
    (match period-info
      info (is-eq (get status info) "closed")
      false
    )
  )
)

(define-private (get-usage-for-meter (meter-id principal) (period uint))
  (let ((submission (contract-call? .meter-data-contract get-submission meter-id period)))
    (match submission
      sub (get reading-value sub)
      u0
    )
  )
)

(define-private (calculate-amount (usage uint) (rate uint))
  (if (is-eq usage u0)
    u0
    (* usage rate)
  )
)

(define-public (set-admin (new-admin principal))
  (begin
    (asserts! (validate-admin) (err ERR-NOT-AUTHORIZED))
    (var-set admin new-admin)
    (ok true)
  )
)

(define-public (set-global-rate (new-rate uint))
  (begin
    (asserts! (validate-admin) (err ERR-NOT-AUTHORIZED))
    (asserts! (> new-rate u0) (err ERR-INVALID-RATE))
    (var-set rate-per-unit new-rate)
    (ok true)
  )
)

(define-public (set-settlement-rate (settlement-id uint) (rate uint))
  (begin
    (asserts! (validate-admin) (err ERR-NOT-AUTHORIZED))
    (asserts! (> rate u0) (err ERR-INVALID-RATE))
    (map-set settlement-rates settlement-id rate)
    (ok true)
  )
)

(define-public (remove-settlement-rate (settlement-id uint))
  (begin
    (asserts! (validate-admin) (err ERR-NOT-AUTHORIZED))
    (map-delete settlement-rates settlement-id)
    (ok true)
  )
)

(define-public (calculate-bill (meter-id principal) (period uint))
  (let (
    (meter-info (contract-call? .meter-data-contract get-meter-info meter-id))
    (existing-bill (map-get? user-bills { meter-id: meter-id, period: period }))
  )
    (asserts! (is-some meter-info) (err ERR-METER-NOT-REGISTERED))
    (asserts! (get active (unwrap! meter-info (err ERR-METER-NOT-REGISTERED))) (err ERR-METER-NOT-REGISTERED))
    (asserts! (is-none existing-bill) (err ERR-BILL-ALREADY-CALCULATED))
    (asserts! (is-period-closed period) (err ERR-PERIOD-NOT-CLOSED))

    (let (
      (usage (get-usage-for-meter meter-id period))
      (settlement-id (get settlement-id (unwrap! meter-info (err ERR-METER-NOT-REGISTERED))))
      (rate (default-to (var-get rate-per-unit) (map-get? settlement-rates settlement-id)))
      (amount (calculate-amount usage rate))
    )
      (asserts! (> usage u0) (err ERR-ZERO-USAGE))
      (asserts! (is-some rate) (err ERR-RATE-NOT-SET))

      (map-set user-bills
        { meter-id: meter-id, period: period }
        { usage: usage, amount-due: amount, calculated-at: block-height, paid: false, settlement-id: settlement-id }
      )

      (match (map-get? period-totals period)
        totals (map-set period-totals period
                 (merge totals {
                   total-usage: (+ (get total-usage totals) usage),
                   total-billed: (+ (get total-billed totals) amount),
                   bill-count: (+ (get bill-count totals) u1)
                 }))
        (map-set period-totals period
          { total-usage: usage, total-billed: amount, bill-count: u1 })
      )

      (ok { usage: usage, amount: amount })
    )
  )
)

(define-public (batch-calculate-bills (meters (list 50 principal)) (period uint))
  (fold ok
    (map calculate-bill meters (list period period period period period period period period period period
                                      period period period period period period period period period period
                                      period period period period period period period period period period
                                      period period period period period period period period period period
                                      period period period period period period period period period period))
    meters
  )
)

(define-public (mark-bill-paid (meter-id principal) (period uint))
  (let ((bill (unwrap! (map-get? user-bills { meter-id: meter-id, period: period }) (err ERR-BILL-NOT-FOUND))))
    (asserts! (not (get paid bill)) (err ERR-BILL-ALREADY-CALCULATED))
    (map-set user-bills
      { meter-id: meter-id, period: period }
      (merge bill { paid: true })
    )
    (ok true)
  )
)

(define-read-only (get-outstanding-balance (meter-id principal) (up-to-period uint))
  (fold +
    (map (lambda (p) 
           (let ((bill (map-get? user-bills { meter-id: meter-id, period: p })))
             (match bill
               b (if (not (get paid b)) (get amount-due b) u0)
               u0
             )
           ))
         (list u0 u1 u2 u3 u4 u5 u6 u7 u8 u9
               u10 u11 u12 u13 u14 u15 u16 u17 u18 u19
               u20 u21 u22 u23 u24 u25 u26 u27 u28 u29
               u30 u31 u32 u33 u34 u35 u36 u37 u38 u39
               u40 u41 u42 u43 u44 u45 u46 u47 u48 u49))
    u0)
)

(define-read-only (get-settlement-summary (settlement-id uint) (period uint))
  (let (
    (total (default-to { total-usage: u0, total-billed: u0, bill-count: u0 } (map-get? period-totals period)))
    (rate (default-to (var-get rate-per-unit) (map-get? settlement-rates settlement-id)))
  )
    (ok {
      settlement-id: settlement-id,
      period: period,
      total-usage: (get total-usage total),
      total-billed: (get total-billed total),
      bill-count: (get bill-count total),
      effective-rate: rate
    })
  )
)