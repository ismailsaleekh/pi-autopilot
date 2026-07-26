use proc_macro::TokenStream;
use proc_macro2::Span;
use quote::{format_ident, quote};
use syn::punctuated::Punctuated;
use syn::{
    AngleBracketedGenericArguments, Expr, ExprLit, ExprPath, GenericArgument, ItemFn, Lit, Meta,
    PathArguments, ReturnType, Token, Type, TypePath, parse_macro_input,
};

#[proc_macro_attribute]
pub fn acceptance_boundary(attr: TokenStream, item: TokenStream) -> TokenStream {
    let args = parse_macro_input!(attr with Punctuated::<Meta, Token![,]>::parse_terminated);
    let input = parse_macro_input!(item as ItemFn);

    match expand(args, input) {
        Ok(tokens) => tokens.into(),
        Err(error) => error.to_compile_error().into(),
    }
}

struct Args {
    id: String,
    producer_variant: syn::Ident,
    admits: String,
    mode_variant: syn::Ident,
}

fn expand(
    args: Punctuated<Meta, Token![,]>,
    input: ItemFn,
) -> syn::Result<proc_macro2::TokenStream> {
    let parsed = parse_args(args)?;
    verify_return(&input)?;

    let vis = &input.vis;
    let sig = &input.sig;
    let block = &input.block;
    let fn_ident = &input.sig.ident;
    let id = parsed.id;
    let admits = parsed.admits;
    let producer_variant = parsed.producer_variant;
    let mode_variant = parsed.mode_variant;
    let static_ident = format_ident!("__BOUNDARY_{}", fn_ident.to_string().to_uppercase());

    Ok(quote! {
        #[linkme::distributed_slice(::kernel::boundary::BOUNDARIES)]
        static #static_ident: ::kernel::boundary::BoundaryDescriptor =
            ::kernel::boundary::BoundaryDescriptor::__macro_new(
                #id,
                ::kernel::boundary::Producer::#producer_variant,
                #admits,
                ::kernel::boundary::BoundaryMode::#mode_variant,
            );

        #vis #sig #block
    })
}

fn parse_args(args: Punctuated<Meta, Token![,]>) -> syn::Result<Args> {
    let mut id = None;
    let mut producer_variant = None;
    let mut visible = None;
    let mut admits = None;
    let mut mode_variant = None;

    for meta in args {
        let Meta::NameValue(name_value) = meta else {
            return Err(syn::Error::new_spanned(
                meta,
                "expected name = value in acceptance_boundary",
            ));
        };
        let Some(name) = name_value.path.get_ident().map(ToString::to_string) else {
            return Err(syn::Error::new_spanned(
                name_value.path,
                "expected a simple acceptance_boundary argument name",
            ));
        };

        match name.as_str() {
            "id" => {
                id = Some(string_value(name_value.value, "id")?);
            }
            "producer" => {
                producer_variant = Some(enum_variant(
                    name_value.value,
                    "producer",
                    &[
                        "Model",
                        "VersionControl",
                        "Operator",
                        "Filesystem",
                        "Provider",
                        "BackgroundTask",
                        "Package",
                        "Host",
                    ],
                )?);
            }
            "visible" => {
                let is_visible = bool_value(name_value.value, "visible")?;
                if !is_visible {
                    return Err(syn::Error::new(
                        Span::call_site(),
                        "visible = false is forbidden: five live boundary incidents shared a private producer rule; put the admits text in front of the producer instead",
                    ));
                }
                visible = Some(true);
            }
            "admits" => {
                admits = Some(string_value(name_value.value, "admits")?);
            }
            "mode" => {
                mode_variant = Some(enum_variant(
                    name_value.value,
                    "mode",
                    &["Record", "Enforce"],
                )?);
            }
            _ => {
                return Err(syn::Error::new_spanned(
                    name_value.path,
                    "unknown acceptance_boundary argument",
                ));
            }
        }
    }

    let id = id.ok_or_else(|| syn::Error::new(Span::call_site(), "missing id"))?;
    let producer_variant =
        producer_variant.ok_or_else(|| syn::Error::new(Span::call_site(), "missing producer"))?;
    let admits = admits.ok_or_else(|| syn::Error::new(Span::call_site(), "missing admits"))?;
    let mode_variant = match mode_variant {
        Some(mode) => mode,
        None if producer_variant == "Model" => syn::Ident::new("Record", Span::call_site()),
        None => syn::Ident::new("Enforce", Span::call_site()),
    };
    let _visible = visible;

    Ok(Args {
        id,
        producer_variant,
        admits,
        mode_variant,
    })
}

fn string_value(value: Expr, name: &str) -> syn::Result<String> {
    match value {
        Expr::Lit(ExprLit {
            lit: Lit::Str(value),
            ..
        }) => Ok(value.value()),
        other => Err(syn::Error::new_spanned(
            other,
            format!("{name} must be a string literal"),
        )),
    }
}

fn bool_value(value: Expr, name: &str) -> syn::Result<bool> {
    match value {
        Expr::Lit(ExprLit {
            lit: Lit::Bool(value),
            ..
        }) => Ok(value.value),
        other => Err(syn::Error::new_spanned(
            other,
            format!("{name} must be a boolean literal"),
        )),
    }
}

fn enum_variant(value: Expr, name: &str, allowed: &[&str]) -> syn::Result<syn::Ident> {
    let Expr::Path(ExprPath { path, .. }) = value else {
        return Err(syn::Error::new(
            Span::call_site(),
            format!("{name} must be an enum path"),
        ));
    };
    let Some(segment) = path.segments.last() else {
        return Err(syn::Error::new(
            Span::call_site(),
            format!("{name} must name a variant"),
        ));
    };
    let variant = segment.ident.to_string();
    if allowed
        .iter()
        .any(|allowed_variant| *allowed_variant == variant)
    {
        Ok(segment.ident.clone())
    } else {
        Err(syn::Error::new_spanned(
            segment,
            format!("{name} variant is not in the closed boundary enum"),
        ))
    }
}

fn verify_return(input: &ItemFn) -> syn::Result<()> {
    let ReturnType::Type(_, return_type) = &input.sig.output else {
        return Err(syn::Error::new_spanned(
            &input.sig.ident,
            "acceptance_boundary functions must return Result<_, Rejection>",
        ));
    };

    if is_result_with_rejection(return_type) {
        Ok(())
    } else {
        Err(syn::Error::new_spanned(
            return_type,
            "acceptance_boundary functions must return Result<_, Rejection>",
        ))
    }
}

fn is_result_with_rejection(return_type: &Type) -> bool {
    let Type::Path(TypePath { path, .. }) = return_type else {
        return false;
    };
    let Some(result_segment) = path.segments.last() else {
        return false;
    };
    if result_segment.ident != "Result" {
        return false;
    }
    let PathArguments::AngleBracketed(AngleBracketedGenericArguments { args, .. }) =
        &result_segment.arguments
    else {
        return false;
    };
    if args.len() != 2 {
        return false;
    }
    let Some(GenericArgument::Type(error_type)) = args.iter().nth(1) else {
        return false;
    };
    type_suffix_is(error_type, "Rejection")
}

fn type_suffix_is(value: &Type, expected: &str) -> bool {
    let Type::Path(TypePath { path, .. }) = value else {
        return false;
    };
    path.segments
        .last()
        .is_some_and(|segment| segment.ident == expected)
}
