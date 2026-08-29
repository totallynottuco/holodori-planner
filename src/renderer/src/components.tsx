import { X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { progressionManifest } from '@shared/manifest'
import type { Attribute, CardCatalogEntry, ResourceKey } from '@shared/types'

export function cardThumbnailUrl(card: CardCatalogEntry): string {
  return `./assets/cards/${encodeURIComponent(card.assetId)}.webp`
}

export function materialIconUrl(key: ResourceKey | 'bloomPoints'): string {
  return `./assets/materials/${encodeURIComponent(progressionManifest.resourceAssets[key].fileName)}`
}

export function CardThumbnail({ card, alt = '', className = '' }: { card: CardCatalogEntry; alt?: string; className?: string }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  if (failed) return <div className={`card-image-fallback ${card.attribute} ${className}`} aria-label={alt || `${card.memberName} thumbnail unavailable`}>{card.memberName.charAt(0)}</div>
  return <img className={className} src={cardThumbnailUrl(card)} alt={alt} loading="lazy" decoding="async" onError={() => setFailed(true)} />
}

export function MaterialIcon({ resource, className = '' }: { resource: ResourceKey | 'bloomPoints'; className?: string }): React.JSX.Element {
  return <img className={`material-icon ${className}`} src={materialIconUrl(resource)} alt="" loading="lazy" decoding="async" />
}

export function AttributeChip({ attribute }: { attribute: Attribute }): React.JSX.Element {
  return <span className={`attribute-chip ${attribute}`}>{attribute[0].toUpperCase() + attribute.slice(1)}</span>
}

export function Rarity({ value }: { value: number }): React.JSX.Element {
  return <span className={`rarity rarity-${value}`} aria-label={`${value} star rarity`}>{'★'.repeat(value)}</span>
}

export function CardIdentity({ card, compact = false }: { card: CardCatalogEntry; compact?: boolean }): React.JSX.Element {
  return (
    <div className={`card-identity ${compact ? 'compact' : ''}`}>
      <CardThumbnail card={card} className="card-identity-image" />
      <div className="identity-copy">
        <strong>{card.memberName}</strong>
        <span>{card.cardName}</span>
        {!compact && <div className="chip-row"><Rarity value={card.rarity} /><AttributeChip attribute={card.attribute} /></div>}
      </div>
    </div>
  )
}

export function EmptyState({ title, action }: { title: string; action?: ReactNode }): React.JSX.Element {
  return <div className="empty-state"><div className="empty-diamond" aria-hidden="true" /><strong>{title}</strong>{action}</div>
}

export function Modal({ title, children, onClose, footer, wide = false }: { title: string; children: ReactNode; onClose(): void; footer: ReactNode; wide?: boolean }): React.JSX.Element {
  const previousFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const closeRef = useRef(onClose)
  const titleId = useId()
  closeRef.current = onClose
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeRef.current()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('keydown', closeOnEscape)
      previousFocus.current?.focus()
    }
  }, [])
  const dialog = (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header><h2 id={titleId}>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close"><X size={20} /></button></header>
        <div className="modal-body">{children}</div>
        <footer>{footer}</footer>
      </section>
    </div>
  )
  return createPortal(dialog, document.getElementById('modal-root') ?? document.body)
}

export function NumberField({ label, value, min = 0, max, onChange, disabled = false }: {
  label: string
  value: number
  min?: number
  max?: number
  onChange(value: number): void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <label className="field"><span>{label}</span><input type="number" min={min} max={max} step="1" value={value} disabled={disabled} onChange={(event) => onChange(Math.max(min, Math.min(max ?? Number.MAX_SAFE_INTEGER, Math.trunc(Number(event.target.value) || 0))))} /></label>
  )
}
