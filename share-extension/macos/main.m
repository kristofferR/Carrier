// Carrier Share — the macOS share extension (Ref #211).
//
// The share sheet only lists apps that bundle an .appex, so this tiny
// sandboxed extension is what puts Carrier in the menu. It presents no UI:
// the attachments are serialized onto a private named pasteboard, the main
// app is told to take over via carrier://share-pasteboard, and the request
// completes.
//
// Why the pasteboard and not an app-group container: a group container is
// only reachable with a signature whose team matches the group prefix, so it
// fails outright in ad-hoc-signed development builds (EPERM). The pasteboard
// is available to a sandboxed extension unconditionally, so the same code
// path works in dev and in release. The main app validates everything it
// reads back — see macos/share_intake.rs.

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>

static NSString *const kCarrierPasteboard = @"io.github.kristofferr.carrier.share";
static NSString *const kCarrierHandoffURL = @"carrier://share-pasteboard";
/// Mirrors the intake's cap; a larger selection is refused here so the sheet
/// reports the failure instead of the app silently dropping it.
static const NSUInteger kCarrierMaxBytes = 100 * 1024 * 1024;

@interface CarrierShareViewController : NSViewController <NSExtensionRequestHandling>
@property(atomic) BOOL started;
@property(nonatomic, strong) NSExtensionContext *shareContext;
@end

@implementation CarrierShareViewController

- (void)loadView {
  // Never meaningfully shown; the request is handled from
  // beginRequestWithExtensionContext: (the host may never present this view).
  self.view = [[NSView alloc] initWithFrame:NSZeroRect];
}

// The system calls this on the principal class when the request starts,
// independent of whether the (empty) view is ever presented.
- (void)beginRequestWithExtensionContext:(NSExtensionContext *)context {
  NSLog(@"Carrier Share: beginRequest");
  self.shareContext = context;
  [self processRequest];
}

// Backup entry in case a macOS release presents the view without calling
// beginRequest on view-controller principals.
- (void)viewDidAppear {
  [super viewDidAppear];
  if (!self.shareContext) {
    self.shareContext = self.extensionContext;
  }
  [self processRequest];
}

- (NSString *)extensionForType:(NSString *)typeIdentifier {
  if (!typeIdentifier) {
    return nil;
  }
  CFStringRef ext = UTTypeCopyPreferredTagWithClass((__bridge CFStringRef)typeIdentifier,
                                                    kUTTagClassFilenameExtension);
  return ext ? (__bridge_transfer NSString *)ext : nil;
}

// A flat, traversal-free name for one incoming attachment.
- (NSString *)nameForIndex:(NSUInteger)index
             suggestedName:(NSString *)suggested
                  fallback:(NSString *)fallbackExtension {
  NSString *base = suggested.lastPathComponent;
  if (base.length == 0 || [base hasPrefix:@"."]) {
    base = [NSString stringWithFormat:@"shared-%lu", (unsigned long)index];
    if (fallbackExtension.length > 0) {
      base = [base stringByAppendingPathExtension:fallbackExtension] ?: base;
    }
  }
  return base;
}

- (void)processRequest {
  @synchronized(self) {
    if (self.started) {
      return;
    }
    self.started = YES;
  }
  NSExtensionContext *context = self.shareContext;
  if (!context) {
    NSLog(@"Carrier Share: no extension context");
    return;
  }

  // Index-keyed so the payload keeps the order the user selected in, even
  // though the providers complete out of order.
  NSMutableDictionary<NSNumber *, NSDictionary *> *collected = [NSMutableDictionary dictionary];
  dispatch_group_t group = dispatch_group_create();
  NSUInteger index = 0;

  for (NSExtensionItem *item in context.inputItems) {
    for (NSItemProvider *provider in item.attachments) {
      NSNumber *slot = @(index++);
      dispatch_group_enter(group);
      void (^collect)(NSString *, NSData *) = ^(NSString *name, NSData *data) {
        if (name.length > 0 && data.length > 0) {
          @synchronized(collected) {
            collected[slot] = @{
              @"name" : name,
              @"data" : [data base64EncodedStringWithOptions:0],
              @"bytes" : @(data.length),
            };
          }
        }
      };

      if ([provider hasItemConformingToTypeIdentifier:@"public.file-url"]) {
        [provider loadItemForTypeIdentifier:@"public.file-url"
                                    options:nil
                          completionHandler:^(id<NSSecureCoding> loaded, NSError *error) {
                            NSURL *source = nil;
                            if ([(NSObject *)loaded isKindOfClass:[NSURL class]]) {
                              source = (NSURL *)loaded;
                            } else if ([(NSObject *)loaded isKindOfClass:[NSData class]]) {
                              source = [NSURL URLWithDataRepresentation:(NSData *)loaded
                                                          relativeToURL:nil];
                            }
                            if (source.isFileURL) {
                              NSData *data = [NSData dataWithContentsOfURL:source];
                              collect([self nameForIndex:slot.unsignedIntegerValue
                                           suggestedName:source.lastPathComponent
                                                fallback:nil],
                                      data);
                            } else if (error) {
                              NSLog(@"Carrier Share: file-url load failed: %@", error);
                            }
                            dispatch_group_leave(group);
                          }];
      } else if ([provider hasItemConformingToTypeIdentifier:@"public.data"]) {
        NSString *extension =
            [self extensionForType:provider.registeredTypeIdentifiers.firstObject];
        [provider loadItemForTypeIdentifier:@"public.data"
                                    options:nil
                          completionHandler:^(id<NSSecureCoding> loaded, NSError *error) {
                            if ([(NSObject *)loaded isKindOfClass:[NSData class]]) {
                              collect([self nameForIndex:slot.unsignedIntegerValue
                                           suggestedName:nil
                                                fallback:extension],
                                      (NSData *)loaded);
                            } else if (error) {
                              NSLog(@"Carrier Share: data load failed: %@", error);
                            }
                            dispatch_group_leave(group);
                          }];
      } else {
        dispatch_group_leave(group);
      }
    }
  }

  dispatch_group_notify(group, dispatch_get_main_queue(), ^{
    NSMutableArray<NSDictionary *> *payload = [NSMutableArray array];
    NSUInteger totalBytes = 0;
    for (NSNumber *slot in [collected.allKeys sortedArrayUsingSelector:@selector(compare:)]) {
      NSDictionary *entry = collected[slot];
      totalBytes += [entry[@"bytes"] unsignedIntegerValue];
      if (totalBytes > kCarrierMaxBytes) {
        NSLog(@"Carrier Share: selection over the size cap");
        [context cancelRequestWithError:[NSError errorWithDomain:@"carrier.share"
                                                            code:3
                                                        userInfo:nil]];
        return;
      }
      [payload addObject:@{@"name" : entry[@"name"], @"data" : entry[@"data"]}];
    }
    NSLog(@"Carrier Share: collected %lu attachment(s)", (unsigned long)payload.count);
    if (payload.count == 0) {
      [context cancelRequestWithError:[NSError errorWithDomain:@"carrier.share"
                                                          code:2
                                                      userInfo:nil]];
      return;
    }

    NSData *json = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
    NSString *serialized = json ? [[NSString alloc] initWithData:json
                                                       encoding:NSUTF8StringEncoding]
                                : nil;
    if (!serialized) {
      NSLog(@"Carrier Share: serializing the payload failed");
      [context cancelRequestWithError:[NSError errorWithDomain:@"carrier.share"
                                                          code:4
                                                      userInfo:nil]];
      return;
    }

    NSPasteboard *pasteboard = [NSPasteboard pasteboardWithName:kCarrierPasteboard];
    [pasteboard clearContents];
    BOOL wrote = [pasteboard setString:serialized forType:NSPasteboardTypeString];
    BOOL opened = [[NSWorkspace sharedWorkspace] openURL:[NSURL URLWithString:kCarrierHandoffURL]];
    NSLog(@"Carrier Share: pasteboard %@, handoff %@", wrote ? @"written" : @"FAILED",
          opened ? @"opened" : @"FAILED");
    [context completeRequestReturningItems:@[] completionHandler:nil];
  });
}

@end
